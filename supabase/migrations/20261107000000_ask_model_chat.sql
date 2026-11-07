-- Already applied to the ISM4421NFLPicks Supabase project. Kept here as a record.
-- "Ask the model" chatbot on the Player props page. The Edge Function `ask-model` is the only
-- writer: it uses the service role, so these tables have no policies for app users except
-- reading chat_config.

-- Settings, one row. `providers` is tried in order; switching to Claude later means adding an
-- `anthropic_api_key` Vault secret and putting {"provider":"anthropic","model":"claude-haiku-5-5",...} first.
-- rpd / tpd are the free-tier daily limits, used only by the chat_usage_today view.
create table public.chat_config (
  id smallint primary key default 1 check (id = 1),
  daily_limit integer not null default 30 check (daily_limit between 0 and 1000),
  history_turns smallint not null default 3 check (history_turns between 0 and 10),
  max_rounds smallint not null default 4 check (max_rounds between 1 and 8),
  max_output_tokens integer not null default 800 check (max_output_tokens between 100 and 4000),
  news_flag_edge numeric(5, 3) not null default 0.15,
  providers jsonb not null default '[
    {"provider": "gemini", "model": "gemini-3.5-flash-lite", "key": "gemini_api_key", "rpd": 500},
    {"provider": "groq", "model": "openai/gpt-oss-120b", "key": "groq_api_key", "rpd": 1000, "tpd": 200000}
  ]'::jsonb,
  updated_at timestamptz not null default now()
);
insert into public.chat_config (id) values (1);
alter table public.chat_config enable row level security;
create policy "Signed-in users read chat settings" on public.chat_config for select to authenticated using (true);
revoke all on public.chat_config from anon, authenticated;
grant select on public.chat_config to authenticated;

-- One row per question. `day` is the Eastern-time date the per-user limit counts against.
-- `transcript` holds the in-progress exchange with the AI provider and is cleared when the
-- question finishes (or after an hour if it's abandoned). No email or bankroll is ever in it.
create table public.chat_turns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  day date not null default (now() at time zone 'America/New_York')::date,
  status text not null default 'pending' check (status in ('pending', 'done', 'busy', 'error')),
  provider text,
  model text,
  rounds smallint not null default 0,
  pending_calls jsonb,
  transcript jsonb,
  finished_at timestamptz
);
create index chat_turns_user_day_idx on public.chat_turns (user_id, day);
alter table public.chat_turns enable row level security;
revoke all on public.chat_turns from anon, authenticated;

-- One row per call to an AI provider: which one, how many tokens, and how it went. No question text.
create table public.chat_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  turn_id uuid references public.chat_turns (id) on delete set null,
  user_id uuid references auth.users (id) on delete set null,
  provider text not null,
  model text not null,
  round smallint not null,
  status text not null check (status in ('ok', 'rate_limited', 'error')),
  http_status smallint,
  input_tokens integer,
  output_tokens integer,
  thought_tokens integer,
  cached_tokens integer,
  latency_ms integer,
  error text check (char_length(error) <= 300)
);
create index chat_log_created_idx on public.chat_log (created_at desc);
alter table public.chat_log enable row level security;
revoke all on public.chat_log from anon, authenticated;

-- A provider that answered "rate limited" is skipped until cooldown_until.
create table public.chat_provider_state (
  provider text primary key,
  cooldown_until timestamptz,
  reason text check (char_length(reason) <= 200),
  updated_at timestamptz not null default now()
);
alter table public.chat_provider_state enable row level security;
revoke all on public.chat_provider_state from anon, authenticated;

-- Starts a question if the user is under today's limit. Returns the new turn id and how many
-- questions are left, or a null id when the limit is reached. Busy and failed questions don't count.
create function public.chat_start_turn(p_user uuid, p_limit integer)
returns table (turn_id uuid, used integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  today date := (now() at time zone 'America/New_York')::date;
  n integer;
  new_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext(p_user::text));
  select count(*) into n from public.chat_turns t
    where t.user_id = p_user and t.day = today and t.status in ('pending', 'done');
  if n >= p_limit then
    return query select null::uuid, n;
    return;
  end if;
  insert into public.chat_turns (user_id, day) values (p_user, today) returning id into new_id;
  -- Abandoned questions don't keep their transcript around.
  update public.chat_turns set transcript = null, pending_calls = null, status = 'error', finished_at = now()
    where status = 'pending' and created_at < now() - interval '1 hour';
  return query select new_id, n + 1;
end;
$$;
revoke all on function public.chat_start_turn(uuid, integer) from public, anon, authenticated;
grant execute on function public.chat_start_turn(uuid, integer) to service_role;

-- The AI provider keys live in Vault. Only the Edge Function (service role) can read them.
create function public.chat_provider_key(p_name text)
returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets
  where name = p_name and p_name in ('gemini_api_key', 'groq_api_key', 'anthropic_api_key')
$$;
revoke all on function public.chat_provider_key(text) from public, anon, authenticated;
grant execute on function public.chat_provider_key(text) to service_role;

-- How close today is to the free-tier limits. Gemini's daily quota resets at midnight Pacific,
-- so "today" is the Pacific date. Read it in the SQL editor: select * from chat_usage_today;
create view public.chat_usage_today
with (security_invoker = true)
as
with cfg as (
  select p->>'provider' as provider, p->>'model' as model, (p->>'rpd')::integer as free_rpd, (p->>'tpd')::integer as free_tpd
  from public.chat_config c, jsonb_array_elements(c.providers) p
),
used as (
  select l.provider, l.model,
    count(*) as requests,
    count(*) filter (where l.status = 'rate_limited') as rate_limited,
    count(*) filter (where l.status = 'error') as errors,
    count(distinct l.turn_id) filter (where l.status = 'ok') as questions,
    coalesce(sum(l.input_tokens), 0) as input_tokens,
    coalesce(sum(l.output_tokens), 0) as output_tokens,
    coalesce(sum(l.cached_tokens), 0) as cached_tokens
  from public.chat_log l
  where l.created_at >= ((now() at time zone 'America/Los_Angeles')::date::timestamp at time zone 'America/Los_Angeles')
  group by l.provider, l.model
)
select coalesce(u.provider, c.provider) as provider, coalesce(u.model, c.model) as model,
  coalesce(u.questions, 0) as questions, coalesce(u.requests, 0) as requests, c.free_rpd,
  case when c.free_rpd > 0 then round(100.0 * coalesce(u.requests, 0) / c.free_rpd, 1) end as pct_of_free_requests,
  coalesce(u.input_tokens, 0) + coalesce(u.output_tokens, 0) as tokens, c.free_tpd,
  case when c.free_tpd > 0 then round(100.0 * (coalesce(u.input_tokens, 0) + coalesce(u.output_tokens, 0) - coalesce(u.cached_tokens, 0)) / c.free_tpd, 1) end as pct_of_free_tokens,
  case when coalesce(u.questions, 0) > 0 then round((coalesce(u.input_tokens, 0) + coalesce(u.output_tokens, 0))::numeric / u.questions) end as tokens_per_question,
  coalesce(u.rate_limited, 0) as rate_limited, coalesce(u.errors, 0) as errors
from used u full join cfg c on c.provider = u.provider and c.model = u.model;
revoke all on public.chat_usage_today from anon, authenticated;

-- Day-by-day history of the same numbers (Pacific dates).
create view public.chat_usage_daily
with (security_invoker = true)
as
select (l.created_at at time zone 'America/Los_Angeles')::date as day, l.provider, l.model,
  count(distinct l.turn_id) filter (where l.status = 'ok') as questions, count(*) as requests,
  count(*) filter (where l.status = 'rate_limited') as rate_limited,
  sum(l.input_tokens) as input_tokens, sum(l.output_tokens) as output_tokens, sum(l.cached_tokens) as cached_tokens,
  round((sum(l.input_tokens) + sum(l.output_tokens))::numeric / nullif(count(distinct l.turn_id) filter (where l.status = 'ok'), 0)) as tokens_per_question
from public.chat_log l
group by 1, 2, 3;
revoke all on public.chat_usage_daily from anon, authenticated;

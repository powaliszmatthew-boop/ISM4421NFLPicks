-- Already applied to the ISM4421NFLPicks Supabase project. Kept here as a record.
-- Parlays: one row in bets (kind 'parlay', combined odds and stake) plus one row per leg.
alter table public.bets drop constraint bets_kind_check;
alter table public.bets add constraint bets_kind_check check (kind in ('game', 'prop', 'parlay'));

create table public.bet_legs (
  id uuid primary key default gen_random_uuid(),
  bet_id uuid not null references public.bets (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  position smallint not null default 0,
  kind text not null check (kind in ('game', 'prop')),
  description text not null check (char_length(description) between 1 and 200),
  odds integer not null check (odds <= -100 or odds >= 100),
  result text not null default 'pending' check (result in ('pending', 'win', 'loss', 'push', 'void')),
  model_prob numeric(6, 5) check (model_prob between 0 and 1),
  market text check (market in ('ML', 'ATS', 'TOT', 'PROP')),
  game_id text check (char_length(game_id) <= 40),
  side text check (side in ('home', 'away', 'over', 'under')),
  line numeric(7, 1),
  player_id text check (char_length(player_id) <= 20),
  player_name text check (char_length(player_name) <= 80),
  stat text check (char_length(stat) <= 30),
  season smallint,
  week smallint
);
create index bet_legs_bet_id_idx on public.bet_legs (bet_id);
create index bet_legs_user_id_idx on public.bet_legs (user_id);

alter table public.bet_legs enable row level security;
create policy "Users read own legs" on public.bet_legs for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users add legs to own bets" on public.bet_legs for insert to authenticated
  with check ((select auth.uid()) = user_id
    and exists (select 1 from public.bets b where b.id = bet_id and b.user_id = (select auth.uid())));
create policy "Users change own legs" on public.bet_legs for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users delete own legs" on public.bet_legs for delete to authenticated using ((select auth.uid()) = user_id);
revoke all on public.bet_legs from anon, authenticated;
grant select, insert, update, delete on public.bet_legs to authenticated;

-- Saves a parlay and its legs in one transaction. Runs as the caller, so row-level security applies.
create function public.create_parlay(p_bet jsonb, p_legs jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  new_id uuid;
begin
  if jsonb_typeof(p_legs) <> 'array' or jsonb_array_length(p_legs) < 2 or jsonb_array_length(p_legs) > 20 then
    raise exception 'A parlay needs 2 to 20 legs';
  end if;
  insert into public.bets (kind, description, odds, stake, placed_on, model_prob, edge, notes)
  values ('parlay', p_bet->>'description', (p_bet->>'odds')::integer, (p_bet->>'stake')::numeric,
          coalesce((p_bet->>'placed_on')::date, current_date),
          (p_bet->>'model_prob')::numeric, (p_bet->>'edge')::numeric, p_bet->>'notes')
  returning id into new_id;
  insert into public.bet_legs (bet_id, position, kind, description, odds, model_prob, market, game_id, side, line,
                               player_id, player_name, stat, season, week)
  select new_id, (l.ord - 1)::smallint, l.v->>'kind', l.v->>'description', (l.v->>'odds')::integer,
         (l.v->>'model_prob')::numeric, l.v->>'market', l.v->>'game_id', l.v->>'side', (l.v->>'line')::numeric,
         l.v->>'player_id', l.v->>'player_name', l.v->>'stat', (l.v->>'season')::smallint, (l.v->>'week')::smallint
  from jsonb_array_elements(p_legs) with ordinality as l(v, ord);
  return new_id;
end;
$$;
revoke all on function public.create_parlay(jsonb, jsonb) from public, anon;
grant execute on function public.create_parlay(jsonb, jsonb) to authenticated;

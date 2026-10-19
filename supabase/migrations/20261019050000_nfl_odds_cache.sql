-- Already applied to the shared Supabase project. Kept here as a record.
-- NFL lines from many sportsbooks (The Odds API), cached like the college ones in odds_cache.
-- The API key lives in Vault (secret 'odds_api_key').
create table public.nfl_odds_cache (
  id smallint primary key default 1 check (id = 1),
  fetched_at timestamptz,
  status integer,
  remaining text,
  body jsonb,
  error text
);
alter table public.nfl_odds_cache enable row level security;
create policy "Signed-in users read the NFL odds cache" on public.nfl_odds_cache for select to authenticated using (true);
revoke all on public.nfl_odds_cache from anon, authenticated;
grant select on public.nfl_odds_cache to authenticated;

-- One refresh for one sport ('cfb' -> odds_cache, 'nfl' -> nfl_odds_cache):
-- 3 markets x up to 10 named books = 3 credits. A failed call keeps the last good lines.
create function public.refresh_odds(p_sport text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  api_key text;
  res extensions.http_response;
  left_credits text;
  sport_key text;
begin
  if p_sport = 'cfb' then sport_key := 'americanfootball_ncaaf';
  elsif p_sport = 'nfl' then sport_key := 'americanfootball_nfl';
  else raise exception 'Unknown sport %', p_sport;
  end if;
  insert into public.odds_cache (id) values (1) on conflict (id) do nothing;
  insert into public.nfl_odds_cache (id) values (1) on conflict (id) do nothing;
  select decrypted_secret into api_key from vault.decrypted_secrets where name = 'odds_api_key';
  if api_key is null then return 'no key'; end if;
  res := extensions.http_get('https://api.the-odds-api.com/v4/sports/' || sport_key || '/odds'
      || '?apiKey=' || api_key
      || '&markets=h2h,spreads,totals&oddsFormat=american&dateFormat=iso'
      || '&bookmakers=hardrockbet_fl,hardrockbet,draftkings,fanduel,betmgm,williamhill_us,espnbet,fanatics,betrivers,bovada');
  select h.value into left_credits from unnest(res.headers) h where lower(h.field) = 'x-requests-remaining';
  if p_sport = 'cfb' then
    if res.status = 200 then
      update public.odds_cache set fetched_at = now(), status = res.status, remaining = left_credits, body = res.content::jsonb, error = null where id = 1;
    else
      update public.odds_cache set status = res.status, error = left(res.content, 500) where id = 1;
    end if;
  else
    if res.status = 200 then
      update public.nfl_odds_cache set fetched_at = now(), status = res.status, remaining = left_credits, body = res.content::jsonb, error = null where id = 1;
    else
      update public.nfl_odds_cache set status = res.status, error = left(res.content, 500) where id = 1;
    end if;
  end if;
  return p_sport || ': ' || res.status::text || ' (credits left: ' || coalesce(left_credits, '?') || ')';
end;
$$;
revoke all on function public.refresh_odds(text) from public, anon, authenticated;

-- Kept for the existing schedule; now just the college case of refresh_odds.
create or replace function public.refresh_cfb_odds()
returns text
language sql
security definer
set search_path = ''
as $$ select public.refresh_odds('cfb') $$;
revoke all on function public.refresh_cfb_odds() from public, anon, authenticated;

-- Both sports share the free plan's 500 credits a month (3 per refresh):
--   college: every 8 hours, Monday to Saturday, August to January  -> 18 refreshes a week
--   NFL:     every 12 hours, every day, September to February      -> 14 refreshes a week
-- In the overlapping months that's 96 credits a week, about 415 a month.
select cron.alter_job((select jobid from cron.job where jobname = 'refresh-cfb-odds'), schedule := '7 */8 * 1,8-12 1-6');
select cron.schedule('refresh-nfl-odds', '37 */12 * 1,2,9-12 *', $$select public.refresh_odds('nfl')$$);

-- Already applied to the ISM4421NFLPicks Supabase project. Kept here as a record.
-- Bets from the NFL site and the college football site (ISM4421CFBPicks) share one account but stay separate.
alter table public.bets add column sport text not null default 'nfl' check (sport in ('nfl', 'cfb'));
create index bets_user_sport_idx on public.bets (user_id, sport, placed_on desc);

create or replace function public.create_parlay(p_bet jsonb, p_legs jsonb)
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
  insert into public.bets (kind, sport, description, odds, stake, placed_on, model_prob, edge, notes)
  values ('parlay', coalesce(p_bet->>'sport', 'nfl'), p_bet->>'description', (p_bet->>'odds')::integer,
          (p_bet->>'stake')::numeric, coalesce((p_bet->>'placed_on')::date, current_date),
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

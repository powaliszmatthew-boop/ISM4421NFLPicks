-- Already applied to the ISM4421NFLPicks Supabase project. Kept here as a record.

-- Every bet a user records: game bets (moneyline, spread, total) and player props.
-- game_id/market/side/line and player_id/stat/season/week let the app settle bets automatically.
create table public.bets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  placed_on date not null default current_date,
  kind text not null check (kind in ('game', 'prop')),
  description text not null check (char_length(description) between 1 and 200),
  odds integer not null check (odds <= -100 or odds >= 100),
  stake numeric(12, 2) not null check (stake >= 0 and stake <= 1000000000),
  result text not null default 'pending' check (result in ('pending', 'win', 'loss', 'push', 'void')),
  settled_at timestamptz,
  model_prob numeric(6, 5) check (model_prob between 0 and 1),
  edge numeric(8, 5),
  notes text check (char_length(notes) <= 500),
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
create index bets_user_id_idx on public.bets (user_id, placed_on desc);

-- Player props a user is watching: the book's line and prices. The app recomputes
-- the model's projection and edge for each one every time the page loads.
create table public.props (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  season smallint not null,
  week smallint not null,
  game_id text check (char_length(game_id) <= 40),
  player_id text not null check (char_length(player_id) <= 20),
  player_name text not null check (char_length(player_name) <= 80),
  team text check (char_length(team) <= 4),
  opponent text check (char_length(opponent) <= 4),
  stat text not null check (char_length(stat) <= 30),
  line numeric(7, 1) not null check (line >= 0),
  over_odds integer check (over_odds <= -100 or over_odds >= 100),
  under_odds integer check (under_odds <= -100 or under_odds >= 100),
  book text check (char_length(book) <= 40),
  notes text check (char_length(notes) <= 500)
);
create index props_user_id_idx on public.props (user_id, season desc, week desc);

alter table public.bets enable row level security;
alter table public.props enable row level security;

create policy "Users read own bets" on public.bets for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users add own bets" on public.bets for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users change own bets" on public.bets for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users delete own bets" on public.bets for delete to authenticated using ((select auth.uid()) = user_id);

create policy "Users read own props" on public.props for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users add own props" on public.props for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users change own props" on public.props for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users delete own props" on public.props for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.bets, public.props from anon, authenticated;
grant select, insert, update, delete on public.bets, public.props to authenticated;

-- The model's view of each saved prop, refreshed while the game is upcoming,
-- so past props can be graded against what the model said before kickoff.
alter table public.props
  add column model_mean numeric(8, 2),
  add column model_side text check (model_side in ('over', 'under')),
  add column model_prob numeric(6, 5) check (model_prob between 0 and 1),
  add column model_ev numeric(8, 5),
  add column priced_at timestamptz;

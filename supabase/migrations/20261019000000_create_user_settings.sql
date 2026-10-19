-- Already applied to the ISM4421NFLPicks Supabase project. Kept here as a record.
create table public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  min_edge smallint not null default 3 check (min_edge between 0 and 12),
  markets text[] not null default array['ATS', 'TOT'],
  bankroll numeric(12, 2) not null default 500 check (bankroll >= 0),
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

create policy "Users read own settings" on public.user_settings
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users insert own settings" on public.user_settings
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users update own settings" on public.user_settings
  for update to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on public.user_settings from anon, authenticated;
grant select, insert, update on public.user_settings to authenticated;

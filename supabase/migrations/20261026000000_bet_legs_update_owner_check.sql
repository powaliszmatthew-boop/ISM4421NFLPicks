-- Already applied to the ISM4421NFLPicks Supabase project. Kept here as a record.
-- Updating a leg must not move it onto someone else's bet: check bet ownership like the insert policy does.
drop policy "Users change own legs" on public.bet_legs;
create policy "Users change own legs" on public.bet_legs for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id
    and exists (select 1 from public.bets b where b.id = bet_id and b.user_id = (select auth.uid())));

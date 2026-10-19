-- Privileges for the trusted API, separate from browser JWT roles.
-- No login/password is provisioned by this schema. An operator grants this
-- group to one dedicated backend login on the approved Kanto project.
do $runtime_role$
begin
  if not exists (select 1 from pg_roles where rolname = 'kanto_api_runtime') then
    create role kanto_api_runtime nologin inherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
    comment on role kanto_api_runtime is 'kanto-online/runtime-role/v1';
  elsif exists (
    select 1 from pg_roles where rolname = 'kanto_api_runtime' and
      (rolcanlogin or rolsuper or rolcreatedb or rolcreaterole or rolreplication
       or rolbypassrls or not rolinherit
       or shobj_description(oid, 'pg_authid') is distinct from 'kanto-online/runtime-role/v1')
  ) or exists (
    select 1 from pg_auth_members where member =
      (select oid from pg_roles where rolname = 'kanto_api_runtime')
  ) or exists (
    select 1 from pg_auth_members m join pg_roles r on r.oid = m.member
      where m.roleid = (select oid from pg_roles where rolname = 'kanto_api_runtime')
        and r.rolname in ('anon', 'authenticated', 'authenticator')
  ) then
    raise exception 'Existing kanto_api_runtime role is incompatible; review it without altering unrelated roles';
  end if;
end
$runtime_role$;

-- Remove the inherited PUBLIC schema-create permission even on projects that
-- still have that older default. This does not remove browser schema USAGE.
revoke create on schema public from public, anon, authenticated;
grant usage on schema public, private to kanto_api_runtime;

-- Read and reserve names; handle/ID changes and profile deletion are denied.
-- UPDATE on one column is required by PostgreSQL for the API's FOR UPDATE
-- row locks. This also permits server-side suspension, not handle changes.
grant select (id, handle, suspended_at), insert (id, handle), update (suspended_at)
  on public.profiles to kanto_api_runtime;
create policy "API reads profiles" on public.profiles
  for select to kanto_api_runtime using (true);
create policy "API reserves names" on public.profiles
  for insert to kanto_api_runtime with check (true);
create policy "API locks and moderates profiles" on public.profiles
  for update to kanto_api_runtime using (true) with check (true);

-- The authenticated API coordinates two-player transactions and therefore
-- needs these game rows across owners. API authentication/ownership checks
-- still apply. No browser role inherits this group, and RLS stays enabled.
-- Future tables receive no automatic grant.
grant select, insert, update, delete on
  private.adventures, private.game_sessions, private.input_journal,
  private.battles, private.battle_runs, private.battle_input_journal,
  private.battle_commands, private.trades, private.trade_receipts,
  private.trade_scenes, private.trade_input_journal
  to kanto_api_runtime;
create policy "API coordinates game state" on private.adventures
  for all to kanto_api_runtime using (true) with check (true);
create policy "API coordinates game state" on private.game_sessions
  for all to kanto_api_runtime using (true) with check (true);
create policy "API coordinates game state" on private.input_journal
  for all to kanto_api_runtime using (true) with check (true);
create policy "API coordinates game state" on private.battles
  for all to kanto_api_runtime using (true) with check (true);
create policy "API coordinates game state" on private.battle_runs
  for all to kanto_api_runtime using (true) with check (true);
create policy "API coordinates game state" on private.battle_input_journal
  for all to kanto_api_runtime using (true) with check (true);
create policy "API coordinates game state" on private.battle_commands
  for all to kanto_api_runtime using (true) with check (true);
create policy "API coordinates game state" on private.trades
  for all to kanto_api_runtime using (true) with check (true);
create policy "API coordinates game state" on private.trade_receipts
  for all to kanto_api_runtime using (true) with check (true);
create policy "API coordinates game state" on private.trade_scenes
  for all to kanto_api_runtime using (true) with check (true);
create policy "API coordinates game state" on private.trade_input_journal
  for all to kanto_api_runtime using (true) with check (true);

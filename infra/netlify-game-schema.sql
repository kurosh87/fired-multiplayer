-- Reviewed source for the Netlify game-data baseline.
-- Preserve existing account names, slot UUIDs, revisions and uploaded flash.
-- Game storage is separate; no uploaded flash is promoted into a journal.
-- Core table definitions adapted from supabase/schemas/001_kanto.sql;
-- its source SHA-256 is 625556b380c87403d8c625e35851f07d75b4ed40772e0b72cb3b8ac586090627.
do $$ begin
  if to_regclass('public.profiles') is not null or exists(select 1 from pg_namespace where nspname='private') then
    raise exception 'Game baseline requires an empty game namespace; existing data must be reviewed';
  end if;
end $$;
alter table kanto_preview.profiles add constraint profiles_uuid_identity
  check (id ~ '^[a-fA-F0-9]{8}-([a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}$');
alter table kanto_preview.profiles add column account_uuid uuid generated always as (id::uuid) stored;
alter table kanto_preview.profiles add constraint profiles_account_uuid_unique unique(account_uuid);
alter table kanto_preview.profiles add column suspended_at timestamptz;
alter table kanto_preview.adventures add column owner_uuid uuid generated always as (owner_id::uuid) stored;
alter table kanto_preview.adventures add constraint adventures_identity_unique unique(id,owner_uuid,version,slot);

do $$ begin
  if not exists(select 1 from pg_roles where rolname='kanto_game_runtime') then
    create role kanto_game_runtime nologin inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    comment on role kanto_game_runtime is 'kanto-online/game-runtime/v1';
  elsif exists(select 1 from pg_roles where rolname='kanto_game_runtime' and
      (rolcanlogin or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls or not rolinherit
       or shobj_description(oid,'pg_authid') is distinct from 'kanto-online/game-runtime/v1'))
    or exists(select 1 from pg_auth_members where member=(select oid from pg_roles where rolname='kanto_game_runtime')) then
    raise exception 'Existing kanto_game_runtime role is incompatible';
  end if;
  if exists(select 1 from pg_auth_members where roleid=(select oid from pg_roles where rolname='kanto_game_runtime')
    and member=(select oid from pg_roles where rolname='kanto_netlify_runtime')) then
    raise exception 'The account runtime must not inherit game-data privileges';
  end if;
end $$;

create schema private;
revoke all on schema private from public;
revoke create on schema public from public;
grant usage on schema public,private,kanto_preview to kanto_game_runtime;
-- A security-invoker view preserves one authoritative immutable handle.
-- No duplicated profile table or provider-specific auth.users FK is created.
create view public.profiles with (security_invoker=true) as
  select account_uuid as id,handle,created_at,suspended_at from kanto_preview.profiles;
revoke all on public.profiles from public;
grant select(account_uuid,handle,created_at,suspended_at),update(suspended_at) on kanto_preview.profiles to kanto_game_runtime;
grant select(id,handle,created_at,suspended_at),update(suspended_at) on public.profiles to kanto_game_runtime;
create policy game_reads_profiles on kanto_preview.profiles for select to kanto_game_runtime using (true);
create policy game_locks_profiles on kanto_preview.profiles for update to kanto_game_runtime using (true) with check (true);
-- Metadata access only: the game runtime cannot SELECT or UPDATE solo flash.
grant select(id,owner_uuid,version,slot) on kanto_preview.adventures to kanto_game_runtime;
create policy game_reads_slot_metadata on kanto_preview.adventures for select to kanto_game_runtime using (true);

create table private.adventures (
  id uuid primary key,
  owner_id uuid not null references kanto_preview.profiles(account_uuid),
  version text not null check (version in ('firered','leafgreen')),
  slot integer not null check (slot between 0 and 2),
  revision bigint not null default 0 check (revision >= 0),
  flash bytea check (flash is null or octet_length(flash)=131072),
  updated_at timestamptz not null default now(),
  unique(owner_id,version,slot),
  foreign key(id,owner_id,version,slot)
    references kanto_preview.adventures(id,owner_uuid,version,slot)
);

create table private.game_sessions (
  id uuid primary key,
  owner_id uuid not null references kanto_preview.profiles(account_uuid) on delete cascade,
  adventure_id uuid not null references private.adventures(id) on delete cascade,
  artifact_id text not null,
  seed bigint not null check (seed between 0 and 4294967295),
  initial_flash bytea check (initial_flash is null or octet_length(initial_flash) = 131072),
  base_revision bigint not null,
  fence bigint not null default 1,
  next_sequence bigint not null default 0,
  frame bigint not null default 0,
  status text not null default 'adventure' check (status in ('adventure','lobby','battle','trade','closed')),
  checkpoint bytea,
  checkpoint_frame bigint,
  checkpoint_sequence bigint,
  lease_expires_at timestamptz not null default now() + interval '60 seconds',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  superseded_at timestamptz
);
create unique index sessions_one_writer_per_account
  on private.game_sessions(owner_id) where status <> 'closed';
create index sessions_adventure on private.game_sessions(adventure_id);
create index sessions_expiry on private.game_sessions(lease_expires_at) where status <> 'closed';

create table private.input_journal (
  session_id uuid not null references private.game_sessions(id) on delete cascade,
  sequence bigint not null check (sequence >= 0),
  operation_id text not null,
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  batch jsonb not null,
  acknowledgement jsonb not null,
  created_at timestamptz not null default now(),
  primary key (session_id, sequence),
  unique (session_id, operation_id)
);

create table private.battles (
  id uuid primary key default gen_random_uuid(),
  player_a uuid not null references kanto_preview.profiles(account_uuid),
  player_b uuid not null references kanto_preview.profiles(account_uuid),
  adventure_a uuid not null references private.adventures(id),
  adventure_b uuid not null references private.adventures(id),
  revision_a bigint not null check (revision_a>=0),
  revision_b bigint not null check (revision_b>=0),
  status text not null default 'offered' check (status in ('offered','starting','active','finished','cancelled','expired')),
  rules jsonb not null default '{"format":"singles","levels":"earned","ranked":false}'
    check (rules='{"format":"singles","levels":"earned","ranked":false}'::jsonb),
  result jsonb,
  seed bigint check (seed between 0 and 4294967295),
  artifact_a text,
  artifact_b text,
  expires_at timestamptz not null default now()+interval '5 minutes',
  reservation_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (player_a <> player_b),
  check (adventure_a <> adventure_b),
  check ((status='finished')=(result is not null)),
  check (status not in ('starting','active') or (seed is not null and artifact_a is not null and artifact_b is not null)),
  check ((status='starting')=(reservation_expires_at is not null))
);
create index battles_player_a on private.battles(player_a,created_at desc);
create index battles_player_b on private.battles(player_b,created_at desc);
create index battles_pending_a on private.battles(player_a,expires_at) where status='offered';
create index battles_pending_b on private.battles(player_b,expires_at) where status='offered';
create index battles_starting_expiry on private.battles(reservation_expires_at) where status='starting';

-- One lease owns both original consoles. Browser inputs contain buttons only;
-- all transport blocks, checkpoints and canonical digests remain private.
create table private.battle_runs (
  battle_id uuid primary key references private.battles(id) on delete cascade,
  initial_checkpoint_a bytea not null check (octet_length(initial_checkpoint_a) between 1 and 73400320),
  initial_checkpoint_b bytea not null check (octet_length(initial_checkpoint_b) between 1 and 73400320),
  checkpoint_a bytea check (checkpoint_a is null or octet_length(checkpoint_a) between 1 and 73400320),
  checkpoint_b bytea check (checkpoint_b is null or octet_length(checkpoint_b) between 1 and 73400320),
  checkpoint_frame bigint,
  checkpoint_sequence bigint,
  checkpoint_state jsonb,
  frame bigint not null default 0 check (frame>=0),
  next_sequence bigint not null default 0 check (next_sequence>=0),
  next_input_a bigint not null default 0 check (next_input_a>=0),
  next_input_b bigint not null default 0 check (next_input_b>=0),
  buttons_a integer not null default 0 check (buttons_a between 0 and 1023),
  buttons_b integer not null default 0 check (buttons_b between 0 and 1023),
  connection_a bigint not null default 0 check (connection_a>=0),
  connection_b bigint not null default 0 check (connection_b>=0),
  disconnected_a timestamptz default now(),
  disconnected_b timestamptz default now(),
  decision_kind text check (decision_kind in ('turn','switch')),
  decision_mask integer not null default 0 check (decision_mask between 0 and 3),
  decision_epoch bigint not null default 0 check (decision_epoch>=0),
  decision_deadline timestamptz,
  engine_result jsonb,
  fence bigint not null default 1 check (fence>=1),
  lease_expires_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((decision_kind is null and decision_mask=0 and decision_deadline is null)
    or (decision_kind is not null and decision_deadline is not null)),
  check ((checkpoint_a is null and checkpoint_b is null and checkpoint_frame is null and checkpoint_sequence is null and checkpoint_state is null)
    or (checkpoint_a is not null and checkpoint_b is not null and checkpoint_frame is not null and checkpoint_sequence is not null
      and checkpoint_state is not null and checkpoint_frame>=0 and checkpoint_sequence>=0 and checkpoint_frame<=frame and checkpoint_sequence<=next_sequence))
);
create index battle_runs_lease on private.battle_runs(lease_expires_at);
create table private.battle_input_journal (
  battle_id uuid not null references private.battle_runs(battle_id) on delete cascade,
  sequence bigint not null check (sequence>=0),
  start_frame bigint not null check (start_frame>=0),
  end_frame bigint not null check (end_frame>start_frame),
  ticks integer not null check (ticks between 1 and 60),
  buttons_a integer not null check (buttons_a between 0 and 1023),
  buttons_b integer not null check (buttons_b between 0 and 1023),
  digest_a text not null check (digest_a ~ '^[a-f0-9]{64}$'),
  digest_b text not null check (digest_b ~ '^[a-f0-9]{64}$'),
  transport_digest text not null check (transport_digest ~ '^[a-f0-9]{64}$'),
  state jsonb not null,
  created_at timestamptz not null default now(),
  primary key (battle_id,sequence),
  check (end_frame-start_frame=ticks)
);
create table private.battle_commands (
  battle_id uuid not null references private.battle_runs(battle_id) on delete cascade,
  owner_id uuid not null references kanto_preview.profiles(account_uuid),
  sequence bigint not null check (sequence>=0),
  operation_id text not null check (char_length(operation_id) between 1 and 100),
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  buttons integer not null check (buttons between 0 and 1023),
  apply_frame bigint not null check (apply_frame>=0),
  connection_epoch bigint not null check (connection_epoch>=1),
  created_at timestamptz not null default now(),
  primary key (battle_id,owner_id,sequence),
  unique (battle_id,owner_id,operation_id)
);

create table private.trades (
  id uuid primary key default gen_random_uuid(),
  player_a uuid not null references kanto_preview.profiles(account_uuid),
  player_b uuid not null references kanto_preview.profiles(account_uuid),
  adventure_a uuid not null references private.adventures(id),
  adventure_b uuid not null references private.adventures(id),
  status text not null default 'offered' check (status in ('offered','committing','committed','cancelled','expired')),
  offer_revision bigint not null default 0,
  offer_a jsonb,
  offer_b jsonb,
  confirmed_a boolean not null default false,
  confirmed_b boolean not null default false,
  expires_at timestamptz not null default now() + interval '5 minutes',
  created_at timestamptz not null default now(),
  check (player_a <> player_b),
  check (adventure_a <> adventure_b)
);
create index trades_player_a on private.trades(player_a);
create index trades_player_b on private.trades(player_b);
create index trades_pending_a on private.trades(player_a,expires_at) where status='offered';
create index trades_pending_b on private.trades(player_b,expires_at) where status='offered';
create table private.trade_receipts (
  trade_id uuid primary key references private.trades(id),
  revision_a bigint not null,
  revision_b bigint not null,
  result jsonb not null,
  committed_at timestamptz not null default now()
);

-- Original-C trade scenes are staged separately from the paused adventure.
-- Their checkpoints and journals cannot supersede an adventure until both
-- resulting cartridges and the receipt commit in the same transaction.
create table private.trade_scenes (
  id uuid primary key,
  trade_id uuid not null references private.trades(id) on delete cascade,
  owner_id uuid not null references kanto_preview.profiles(account_uuid),
  adventure_id uuid not null references private.adventures(id),
  side text not null check (side in ('a','b')),
  artifact_id text not null,
  seed bigint not null check (seed between 0 and 4294967295),
  initial_checkpoint bytea not null check (octet_length(initial_checkpoint) between 1 and 73400320),
  checkpoint bytea check (checkpoint is null or octet_length(checkpoint) between 1 and 73400320),
  checkpoint_sequence bigint,
  checkpoint_frame bigint,
  next_sequence bigint not null default 0 check (next_sequence>=0),
  frame bigint not null default 0 check (frame>=0),
  status text not null default 'running' check (status in ('running','done','aborted')),
  result_flash bytea check (result_flash is null or octet_length(result_flash)=131072),
  fence bigint not null default 1,
  lease_expires_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (trade_id,owner_id),
  unique (trade_id,side),
  check ((status='done')=(result_flash is not null)),
  check ((checkpoint is null and checkpoint_sequence is null and checkpoint_frame is null)
    or (checkpoint is not null and checkpoint_sequence is not null and checkpoint_frame is not null
      and checkpoint_sequence>=0 and checkpoint_frame>=0
      and checkpoint_sequence<=next_sequence and checkpoint_frame<=frame))
);
create index trade_scenes_owner_running on private.trade_scenes(owner_id) where status='running';
create index trades_committing_expiry on private.trades(expires_at) where status='committing';
create table private.trade_input_journal (
  scene_id uuid not null references private.trade_scenes(id) on delete cascade,
  sequence bigint not null check (sequence>=0),
  operation_id text not null,
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  batch jsonb not null,
  acknowledgement jsonb not null,
  created_at timestamptz not null default now(),
  primary key (scene_id,sequence),
  unique (scene_id,operation_id)
);


-- Trusted coordinator permissions; neither browser nor account role inherits them.
alter table private.adventures enable row level security;
alter table private.adventures force row level security;
revoke all on private.adventures from public;
grant select,insert on private.adventures to kanto_game_runtime;
grant update(flash,revision,updated_at) on private.adventures to kanto_game_runtime;
create policy game_coordinates_state on private.adventures for all to kanto_game_runtime using (true) with check (true);
alter table private.game_sessions enable row level security;
alter table private.game_sessions force row level security;
revoke all on private.game_sessions from public;
grant select,insert,update,delete on private.game_sessions to kanto_game_runtime;
create policy game_coordinates_state on private.game_sessions for all to kanto_game_runtime using (true) with check (true);
alter table private.input_journal enable row level security;
alter table private.input_journal force row level security;
revoke all on private.input_journal from public;
grant select,insert,update,delete on private.input_journal to kanto_game_runtime;
create policy game_coordinates_state on private.input_journal for all to kanto_game_runtime using (true) with check (true);
alter table private.battles enable row level security;
alter table private.battles force row level security;
revoke all on private.battles from public;
grant select,insert,update,delete on private.battles to kanto_game_runtime;
create policy game_coordinates_state on private.battles for all to kanto_game_runtime using (true) with check (true);
alter table private.battle_runs enable row level security;
alter table private.battle_runs force row level security;
revoke all on private.battle_runs from public;
grant select,insert,update,delete on private.battle_runs to kanto_game_runtime;
create policy game_coordinates_state on private.battle_runs for all to kanto_game_runtime using (true) with check (true);
alter table private.battle_input_journal enable row level security;
alter table private.battle_input_journal force row level security;
revoke all on private.battle_input_journal from public;
grant select,insert,update,delete on private.battle_input_journal to kanto_game_runtime;
create policy game_coordinates_state on private.battle_input_journal for all to kanto_game_runtime using (true) with check (true);
alter table private.battle_commands enable row level security;
alter table private.battle_commands force row level security;
revoke all on private.battle_commands from public;
grant select,insert,update,delete on private.battle_commands to kanto_game_runtime;
create policy game_coordinates_state on private.battle_commands for all to kanto_game_runtime using (true) with check (true);
alter table private.trades enable row level security;
alter table private.trades force row level security;
revoke all on private.trades from public;
grant select,insert,update,delete on private.trades to kanto_game_runtime;
create policy game_coordinates_state on private.trades for all to kanto_game_runtime using (true) with check (true);
alter table private.trade_receipts enable row level security;
alter table private.trade_receipts force row level security;
revoke all on private.trade_receipts from public;
grant select,insert,update,delete on private.trade_receipts to kanto_game_runtime;
create policy game_coordinates_state on private.trade_receipts for all to kanto_game_runtime using (true) with check (true);
alter table private.trade_scenes enable row level security;
alter table private.trade_scenes force row level security;
revoke all on private.trade_scenes from public;
grant select,insert,update,delete on private.trade_scenes to kanto_game_runtime;
create policy game_coordinates_state on private.trade_scenes for all to kanto_game_runtime using (true) with check (true);
alter table private.trade_input_journal enable row level security;
alter table private.trade_input_journal force row level security;
revoke all on private.trade_input_journal from public;
grant select,insert,update,delete on private.trade_input_journal to kanto_game_runtime;
create policy game_coordinates_state on private.trade_input_journal for all to kanto_game_runtime using (true) with check (true);
alter default privileges in schema private revoke all on tables from public;
alter default privileges in schema private revoke execute on functions from public;

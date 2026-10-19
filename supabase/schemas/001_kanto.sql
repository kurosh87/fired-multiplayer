-- Declarative schema. Generate/review a migration against a disposable database
-- before applying to any hosted project. Never expose the private schema.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  handle text not null check (handle ~ '^[A-Za-z][A-Za-z0-9_]{2,15}$'),
  created_at timestamptz not null default now(),
  suspended_at timestamptz
);
create unique index if not exists profiles_handle_unique on public.profiles (lower(handle));
alter table public.profiles enable row level security;
revoke all on public.profiles from anon, authenticated;
grant select (id, handle, created_at) on public.profiles to authenticated;
create policy "Read own profile" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);
-- Names and suspension flags can only be changed through the game server.

create table if not exists private.adventures (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  version text not null check (version in ('firered', 'leafgreen')),
  revision bigint not null default 0 check (revision >= 0),
  flash bytea check (flash is null or octet_length(flash) = 131072),
  updated_at timestamptz not null default now(),
  unique (owner_id, version)
);

create table if not exists private.game_sessions (
  id uuid primary key,
  owner_id uuid not null references public.profiles(id) on delete cascade,
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
create unique index if not exists sessions_one_writer_per_account
  on private.game_sessions(owner_id) where status <> 'closed';
create index if not exists sessions_adventure on private.game_sessions(adventure_id);
create index if not exists sessions_expiry on private.game_sessions(lease_expires_at) where status <> 'closed';

create table if not exists private.input_journal (
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

create table if not exists private.battles (
  id uuid primary key default gen_random_uuid(),
  player_a uuid not null references public.profiles(id),
  player_b uuid not null references public.profiles(id),
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
create index if not exists battles_player_a on private.battles(player_a,created_at desc);
create index if not exists battles_player_b on private.battles(player_b,created_at desc);
create index if not exists battles_pending_a on private.battles(player_a,expires_at) where status='offered';
create index if not exists battles_pending_b on private.battles(player_b,expires_at) where status='offered';
create index if not exists battles_starting_expiry on private.battles(reservation_expires_at) where status='starting';

-- One lease owns both original consoles. Browser inputs contain buttons only;
-- all transport blocks, checkpoints and canonical digests remain private.
create table if not exists private.battle_runs (
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
create index if not exists battle_runs_lease on private.battle_runs(lease_expires_at);
create table if not exists private.battle_input_journal (
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
create table if not exists private.battle_commands (
  battle_id uuid not null references private.battle_runs(battle_id) on delete cascade,
  owner_id uuid not null references public.profiles(id),
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

create table if not exists private.trades (
  id uuid primary key default gen_random_uuid(),
  player_a uuid not null references public.profiles(id),
  player_b uuid not null references public.profiles(id),
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
create index if not exists trades_player_a on private.trades(player_a);
create index if not exists trades_player_b on private.trades(player_b);
create index if not exists trades_pending_a on private.trades(player_a,expires_at) where status='offered';
create index if not exists trades_pending_b on private.trades(player_b,expires_at) where status='offered';
create table if not exists private.trade_receipts (
  trade_id uuid primary key references private.trades(id),
  revision_a bigint not null,
  revision_b bigint not null,
  result jsonb not null,
  committed_at timestamptz not null default now()
);

-- Original-C trade scenes are staged separately from the paused adventure.
-- Their checkpoints and journals cannot supersede an adventure until both
-- resulting cartridges and the receipt commit in the same transaction.
create table if not exists private.trade_scenes (
  id uuid primary key,
  trade_id uuid not null references private.trades(id) on delete cascade,
  owner_id uuid not null references public.profiles(id),
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
create index if not exists trade_scenes_owner_running on private.trade_scenes(owner_id) where status='running';
create index if not exists trades_committing_expiry on private.trades(expires_at) where status='committing';
create table if not exists private.trade_input_journal (
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

-- The lobby directory reads a bounded party summary, never the full cartridge
-- inspection. One row per live lobby session; visible only while that session
-- is in the lobby with a fresh lease.
create table if not exists private.lobby_presence (
  session_id uuid primary key references private.game_sessions(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  version text not null check (version in ('firered','leafgreen')),
  max_party_level int check (max_party_level between 1 and 100),
  party jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists lobby_presence_level on private.lobby_presence(max_party_level);

-- One queue row per waiting trainer. Pairing claims both rows in a single
-- delete so only one side ever starts the match; rows past the TTL are swept
-- opportunistically. An entry is only valid while its session stays in the
-- lobby, and pairing re-checks that in SQL.
create table if not exists private.quick_match_queue (
  owner_id uuid primary key references public.profiles(id) on delete cascade,
  session_id uuid not null references private.game_sessions(id) on delete cascade,
  version text not null check (version in ('firered','leafgreen')),
  ruleset text not null default 'open' check (ruleset in ('open')),
  max_party_level int check (max_party_level between 1 and 100),
  enqueued_at timestamptz not null default now()
);

-- Defense in depth even though these tables are outside the exposed API schema.
alter table private.adventures enable row level security;
alter table private.game_sessions enable row level security;
alter table private.input_journal enable row level security;
alter table private.battles enable row level security;
alter table private.battle_runs enable row level security;
alter table private.battle_input_journal enable row level security;
alter table private.battle_commands enable row level security;
alter table private.trades enable row level security;
alter table private.trade_receipts enable row level security;
alter table private.trade_scenes enable row level security;
alter table private.trade_input_journal enable row level security;
alter table private.lobby_presence enable row level security;
alter table private.quick_match_queue enable row level security;
revoke all on all tables in schema private from public, anon, authenticated;
grant usage on schema private to service_role;
grant all on all tables in schema private to service_role;
grant select, insert, update, delete on public.profiles to service_role;

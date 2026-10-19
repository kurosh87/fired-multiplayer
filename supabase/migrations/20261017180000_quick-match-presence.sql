-- Quick match and lobby presence, mirrored from schemas/001_kanto.sql.
-- The directory reads a bounded party summary (species, name, earned level),
-- never cartridge bytes; pairing re-checks live lobby sessions and unsuspended
-- profiles in SQL, and a claim deletes both queue rows in one statement.
create table if not exists private.lobby_presence (
  session_id uuid primary key references private.game_sessions(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  version text not null check (version in ('firered','leafgreen')),
  max_party_level int check (max_party_level between 1 and 100),
  party jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists lobby_presence_level on private.lobby_presence(max_party_level);
create table if not exists private.quick_match_queue (
  owner_id uuid primary key references public.profiles(id) on delete cascade,
  session_id uuid not null references private.game_sessions(id) on delete cascade,
  version text not null check (version in ('firered','leafgreen')),
  ruleset text not null default 'open' check (ruleset in ('open')),
  max_party_level int check (max_party_level between 1 and 100),
  enqueued_at timestamptz not null default now()
);
-- Defense in depth even though these tables are outside the exposed API schema.
alter table private.lobby_presence enable row level security;
alter table private.quick_match_queue enable row level security;
revoke all on private.lobby_presence from public, anon, authenticated;
revoke all on private.quick_match_queue from public, anon, authenticated;
grant all on private.lobby_presence to service_role;
grant all on private.quick_match_queue to service_role;

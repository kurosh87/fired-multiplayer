-- Quick match and lobby presence. Neither table enables public admission or
-- promotes uploaded cartridges: pairing re-checks live lobby sessions and
-- suspended profiles in SQL, and presence carries a bounded party summary,
-- never cartridge bytes.
create table private.lobby_presence (
  session_id uuid primary key references private.game_sessions(id) on delete cascade,
  owner_id uuid not null references kanto_preview.profiles(account_uuid) on delete cascade,
  version text not null check (version in ('firered','leafgreen')),
  max_party_level int check (max_party_level between 1 and 100),
  party jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
create index lobby_presence_level on private.lobby_presence(max_party_level);
create index lobby_presence_owner on private.lobby_presence(owner_id);
create table private.quick_match_queue (
  owner_id uuid primary key references kanto_preview.profiles(account_uuid) on delete cascade,
  session_id uuid not null references private.game_sessions(id) on delete cascade,
  version text not null check (version in ('firered','leafgreen')),
  ruleset text not null default 'open' check (ruleset in ('open')),
  max_party_level int check (max_party_level between 1 and 100),
  enqueued_at timestamptz not null default now()
);
create index quick_match_session on private.quick_match_queue(session_id);
alter table private.lobby_presence enable row level security;
alter table private.lobby_presence force row level security;
revoke all on private.lobby_presence from public;
grant select,insert,update,delete on private.lobby_presence to kanto_game_runtime;
create policy game_coordinates_lobby_presence on private.lobby_presence for all to kanto_game_runtime using (true) with check (true);
alter table private.quick_match_queue enable row level security;
alter table private.quick_match_queue force row level security;
revoke all on private.quick_match_queue from public;
grant select,insert,update,delete on private.quick_match_queue to kanto_game_runtime;
create policy game_coordinates_quick_match on private.quick_match_queue for all to kanto_game_runtime using (true) with check (true);

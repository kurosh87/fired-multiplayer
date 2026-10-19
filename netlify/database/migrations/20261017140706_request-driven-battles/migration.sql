-- Request-driven consoles retain the same battle/adventure identities. This
-- migration does not enable public admission or promote uploaded cartridges.
create table private.battle_request_runs (
  battle_id uuid primary key references private.battle_runs(battle_id) on delete cascade,
  revision bigint not null default 0 check (revision>=0),
  claim_id uuid,
  claim_until timestamptz,
  clock_us bigint not null check (clock_us>=0),
  credit bigint not null default 0 check (credit between 0 and 21067200000000),
  input_through_a bigint not null default 0 check (input_through_a>=0),
  input_through_b bigint not null default 0 check (input_through_b>=0),
  seen_us_a bigint not null check (seen_us_a>=0),
  seen_us_b bigint not null check (seen_us_b>=0),
  screen_a bytea not null check (octet_length(screen_a) between 1 and 163840),
  screen_b bytea not null check (octet_length(screen_b) between 1 and 163840),
  check ((claim_id is null)=(claim_until is null))
);
create table private.battle_request_inputs (
  battle_id uuid not null references private.battle_request_runs(battle_id) on delete cascade,
  side text not null check (side in ('a','b')),
  start_frame bigint not null check (start_frame>=0),
  end_frame bigint not null check (end_frame>start_frame and end_frame-start_frame<=15),
  buttons integer not null check (buttons between 0 and 1023),
  primary key (battle_id,side,start_frame)
);
create table private.battle_request_receipts (
  battle_id uuid not null references private.battle_request_runs(battle_id) on delete cascade,
  owner_id uuid not null references kanto_preview.profiles(account_uuid),
  sequence bigint not null check (sequence>=0),
  operation_id uuid not null,
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  request jsonb not null,
  response bytea not null check (octet_length(response) between 1 and 2631680),
  created_at timestamptz not null default now(),
  primary key (battle_id,owner_id,sequence),
  unique (battle_id,owner_id,operation_id)
);
alter table private.battle_request_runs enable row level security;
alter table private.battle_request_runs force row level security;
revoke all on private.battle_request_runs from public;
grant select,insert,update,delete on private.battle_request_runs to kanto_game_runtime;
create policy game_coordinates_request_battles on private.battle_request_runs for all to kanto_game_runtime using (true) with check (true);
alter table private.battle_request_inputs enable row level security;
alter table private.battle_request_inputs force row level security;
revoke all on private.battle_request_inputs from public;
grant select,insert,update,delete on private.battle_request_inputs to kanto_game_runtime;
create policy game_coordinates_request_inputs on private.battle_request_inputs for all to kanto_game_runtime using (true) with check (true);
alter table private.battle_request_receipts enable row level security;
alter table private.battle_request_receipts force row level security;
revoke all on private.battle_request_receipts from public;
grant select,insert on private.battle_request_receipts to kanto_game_runtime;
create policy game_coordinates_request_receipts on private.battle_request_receipts for all to kanto_game_runtime using (true) with check (true);
-- The game adapter filters on owner_uuid, not the old text owner_id index.
create index adventures_owner_uuid_slots on kanto_preview.adventures(owner_uuid,version,slot);

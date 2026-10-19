-- Explicit tab replacement is separate from retrying an invocation. Older
-- connection IDs retain their epoch and cannot reclaim control on retry.
alter table private.battle_request_runs
  add column control_id_a uuid,
  add column control_id_b uuid,
  add column control_epoch_a bigint not null default 0 check (control_epoch_a>=0),
  add column control_epoch_b bigint not null default 0 check (control_epoch_b>=0),
  add column last_request_side text check (last_request_side in ('a','b')),
  add column waiting_us_a bigint check (waiting_us_a>=0),
  add column waiting_us_b bigint check (waiting_us_b>=0),
  add constraint battle_control_a_valid check ((control_id_a is null)=(control_epoch_a=0)),
  add constraint battle_control_b_valid check ((control_id_b is null)=(control_epoch_b=0));

create table private.battle_control_connections (
  battle_id uuid not null references private.battle_request_runs(battle_id) on delete cascade,
  owner_id uuid not null references kanto_preview.profiles(account_uuid),
  connection_id uuid not null,
  epoch bigint not null check (epoch>0),
  created_at timestamptz not null default now(),
  primary key (battle_id,owner_id,connection_id),
  unique (battle_id,owner_id,epoch)
);
alter table private.battle_control_connections enable row level security;
alter table private.battle_control_connections force row level security;
revoke all on private.battle_control_connections from public;
grant select,insert on private.battle_control_connections to kanto_game_runtime;
create policy game_coordinates_battle_controls on private.battle_control_connections
  for all to kanto_game_runtime using (true) with check (true);

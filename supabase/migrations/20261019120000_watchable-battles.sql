-- Spectating is opt-in per battle. Existing and new battles default to
-- private; only the lobby live list and watch admission read this column.
alter table private.battles add column if not exists watchable boolean not null default false;
create index if not exists battles_live_watchable on private.battles(updated_at desc) where status='active' and watchable;

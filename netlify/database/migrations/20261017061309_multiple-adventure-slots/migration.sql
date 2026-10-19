-- Expand in place: preserve all existing saves and the legacy default slot.
-- PostgreSQL UUID defaults and column grants are deliberate platform-specific DDL.
alter table kanto_preview.adventures add column id uuid not null default gen_random_uuid();
alter table kanto_preview.adventures add column slot integer not null default 0 check (slot between 0 and 2);
alter table kanto_preview.adventures drop constraint adventures_pkey;
alter table kanto_preview.adventures add primary key(id);
alter table kanto_preview.adventures add constraint adventures_owner_version_slot_unique unique(owner_id,version,slot);
-- Existing owner RLS and column-limited update grants remain in force.
-- The runtime cannot change ids, ownership, editions or slot numbers after creation.

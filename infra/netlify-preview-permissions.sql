-- Postgres-specific permissions and owner RLS, appended after SDK-generated Auth tables.
do $$ begin
  if exists (select 1 from pg_roles where rolname='kanto_netlify_runtime') then
    if obj_description((select oid from pg_roles where rolname='kanto_netlify_runtime'),'pg_authid')
      is distinct from 'Kanto temporary Netlify runtime v1' then
      raise exception 'Existing runtime role is not owned by this migration';
    end if;
  else
    create role kanto_netlify_runtime nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    comment on role kanto_netlify_runtime is 'Kanto temporary Netlify runtime v1';
  end if;
end $$;
grant kanto_netlify_runtime to current_user;
revoke all on schema kanto_auth from public;
grant usage on schema kanto_auth to kanto_netlify_runtime;
revoke all on all tables in schema kanto_auth from public;
grant select,insert,update,delete on all tables in schema kanto_auth to kanto_netlify_runtime;
-- Only the trusted server role can read sessions, password hashes or tokens.
do $$ declare t record; begin
  for t in select tablename from pg_tables where schemaname='kanto_auth' loop
    execute format('alter table kanto_auth.%I enable row level security',t.tablename);
    execute format('alter table kanto_auth.%I force row level security',t.tablename);
    execute format('create policy trusted_auth_server on kanto_auth.%I to kanto_netlify_runtime using (true) with check (true)',t.tablename);
  end loop;
end $$;

create schema kanto_preview;
revoke all on schema kanto_preview from public;
grant usage on schema kanto_preview to kanto_netlify_runtime;
create table kanto_preview.profiles (
  id text primary key references kanto_auth."user"(id),
  handle text not null check (handle ~ '^[A-Za-z][A-Za-z0-9_]{2,15}$'),
  created_at timestamptz not null default now()
);
create unique index profiles_handle_unique on kanto_preview.profiles(lower(handle));
create table kanto_preview.adventures (
  owner_id text not null references kanto_preview.profiles(id),
  version text not null check (version in ('firered','leafgreen')),
  revision integer not null default 0 check (revision >= 0),
  flash bytea,
  sha256 text,
  updated_at timestamptz not null default now(),
  primary key(owner_id,version),
  check ((flash is null and sha256 is null and revision=0) or
    (octet_length(flash)=131072 and sha256 ~ '^[a-f0-9]{64}$' and revision>0 and flash is not null and sha256 is not null))
);
revoke all on all tables in schema kanto_preview from public;
grant select,insert on kanto_preview.profiles to kanto_netlify_runtime;
grant select,insert on kanto_preview.adventures to kanto_netlify_runtime;
grant update(flash,sha256,revision,updated_at) on kanto_preview.adventures to kanto_netlify_runtime;
alter table kanto_preview.profiles enable row level security;
alter table kanto_preview.profiles force row level security;
alter table kanto_preview.adventures enable row level security;
alter table kanto_preview.adventures force row level security;
create policy own_profile on kanto_preview.profiles to kanto_netlify_runtime
  using (id=(select current_setting('kanto.owner_id',true)))
  with check (id=(select current_setting('kanto.owner_id',true)));
create policy own_adventures on kanto_preview.adventures to kanto_netlify_runtime
  using (owner_id=(select current_setting('kanto.owner_id',true)))
  with check (owner_id=(select current_setting('kanto.owner_id',true)));
-- No future table or function gets an implicit public grant.
alter default privileges in schema kanto_auth revoke all on tables from public;
alter default privileges in schema kanto_preview revoke all on tables from public;
alter default privileges in schema kanto_preview revoke execute on functions from public;

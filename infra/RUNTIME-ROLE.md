# Backend database login

The second application migration creates `kanto_api_runtime`, a non-login
group for the trusted API. It is separate from Supabase's browser JWT roles
and from the privileged `service_role`. The group is marked as Kanto-owned;
a pre-existing incompatible role, unexpected inherited membership, or browser
membership causes migration failure rather than silently changing that role.
This is an operator guard, not protection against an existing database admin.

The group gets CRUD on the eleven named private game tables. Their RLS remains
enabled with explicit policies for the trusted game server. This server needs
cross-owner access to coordinate battle reservations and two-save trade
transactions; client authentication and ownership checks still run in the API.
No default privilege grants are added for future tables. Browser roles remain
excluded from the private schema and from this group.

Profile grants allow reading `id`, `handle` and `suspended_at`, inserting an ID
and handle, and updating `suspended_at`. Handle/ID changes, profile deletion and
other profile columns are not granted. PostgreSQL requires UPDATE on at least
one column for `SELECT ... FOR UPDATE`; the suspension-column grant supports
the existing profile row locks and future server moderation. This permission
does not mean a public moderation endpoint exists.

## Provisioning after target approval

Use an administrative connection to the approved dedicated project. Start the
login disabled, grant only the Kanto group, and set its password through an
interactive `psql` password prompt or the platform's private credential flow:

```sql
create role kanto_api_login nologin inherit nosuperuser nocreatedb
  nocreaterole noreplication nobypassrls;
grant kanto_api_runtime to kanto_api_login;
```

In an interactive `psql` session use `\password kanto_api_login`, then enable
LOGIN only after the password is set and the connection configuration has
been checked. Keep the credential in the host's private runtime configuration;
never put it in a migration, shell history, a browser variable or a public
build. The exact pooler address and username format come from the approved
project and must be verified there before deployment.

Do not grant this group to `anon`, `authenticated`, `authenticator`, or a
browser-facing login. It is a direct SQL backend permission group and is not
a custom client JWT role. Keep the project's administrator credential out of
the API runtime. The migration revokes PUBLIC/anon/authenticated CREATE on the
public schema, including older permissive defaults; apply only to the
separate empty Kanto target.

## What has been verified locally

`build/database-migrations-v2/report.json` records actual CLI migration history,
byte-identical declarative/migrated schema dumps and a real non-admin login.
Production data-access classes create trainer names and both slots, recover
and save a session, reserve/release a battle, and atomically update two fixture
saves with one idempotent trade receipt through that login. The check also
rejects access by a non-participant at the repository boundary.

Negative SQL checks deny Auth reads/writes, unrelated and newly added tables,
handle changes, profile deletion, truncation, permanent schema/table DDL,
service/browser-role escalation and role/database creation. Authenticated
browser reads still show only the requesting profile. The test login is
NOLOGIN after cleanup. Saved databases and logs are retained for review.

This proves the tested native database permissions and application data paths.
Hosted Supabase defaults, actual pooler login, signup/email delivery and the
Linux backend still need acceptance on the selected resources. The synthetic
session/trade fixture is not original Pokémon gameplay or multiplayer capacity
qualification. No hosted credentials or paid resources were created.

References: [Supabase migrations](https://supabase.com/docs/guides/deployment/database-migrations),
[Postgres roles on Supabase](https://supabase.com/docs/guides/database/postgres/roles),
and [PostgreSQL 17 SELECT locking privileges](https://www.postgresql.org/docs/17/sql-select.html).

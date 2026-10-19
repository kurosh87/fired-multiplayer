# Private staging setup

The next hosted component is a dedicated `kanto-online-staging` Supabase
Auth/Postgres project in `us-west-2`. The web client and API can initially run
on `127.0.0.1:5173` and `127.0.0.1:8787`. This does not require deploying the
game service or opening public registration/play.

The authenticated CLI currently exposes one organization, `decor AI`, and four
projects belonging to other applications. None is selected or linked to this
repository. Their databases, settings and billing must remain untouched.
Read-only inspection on October 16, 2026 confirmed that organization is on
Free, with `campkernel-beta` and `campkernel-staging` both active. The two
inactive projects are `calcount` and `decorai`. The two active projects already
use the published Free allowance. Do not pause, reuse or upgrade those unrelated
applications to make room for Kanto. There is no Kanto project or root `.env`.
Sanitized observations are retained in `build/hosting-account-readiness.json`;
no provider credentials are stored in that report.

A read-only project-list recheck on October 17 still found no dedicated Kanto
project and no root `.env`; the four unrelated projects retained the same
active/inactive statuses. That check did not re-read the organization's billing
plan. Its sanitized result is `build/hosting-readiness-20261017.json`.

The documented [organization API](https://supabase.com/docs/reference/api/v1-get-an-organization)
exposes the plan, and the [billing guide](https://supabase.com/docs/guides/platform/billing-on-supabase)
explains the two-active-Free-project limit. No browser is connected for dashboard
operations. A dedicated project and verified email-sender details are pending.

## Cost proposal, checked October 16, 2026

| Supabase option | Published starting cost in USD | Scope |
| --- | --- | --- |
| An available Free project | $0/month | 500 MB database; shared compute; two active Free-project limit; inactivity pausing |
| Additional Micro project in an existing paid organization | From $10/month additional compute | 1 GB RAM, shared compute; existing organization subscription continues |
| A new Pro organization with one Micro project | From $25/month total | Includes $10 compute credit for one Micro |

These are published starting prices, not spending caps or an account-specific
quote. Confirm the actual organization plan, available credits and incremental
charge before creation. SMTP, API/game hosting, traffic and other metered usage
are additional. Do not provision the proposed 1,000-player game infrastructure
from these Auth/database prices.

The existing organization is Free, so the additional-Micro row does not apply
to it without changing the organization plan and the other apps' billing.
The isolated paid option is a separate Kanto Pro organization with one project,
starting at $25/month, subject to explicit approval. API/game hosting, SMTP,
tax and metered usage are additional; they have not been provisioned or priced
as a complete 1,000-player service.

Source: [Supabase pricing](https://supabase.com/pricing).

## Configuration to apply after the target and cost are confirmed

1. Create a new, empty staging project; retain its project reference in private
   operator configuration. Do not link or push to any existing unrelated app.
2. Review the two migration files in `supabase/migrations/`:
   `20261017034846_initial_kanto_schema.sql` and
   `20261017035025_api_runtime_role.sql`. They were prepared from the declarative
   files and applied through the actual CLI to fresh native PostgreSQL 17
   databases. Their schema/policy/grant dump matches the declarative state,
   and a second CLI apply makes no duplicate history entries. This was a local
   Unix-socket check, not a hosted migration or a Docker run. After the target
   is approved, link only that empty Kanto project, inspect `supabase db push
   --linked --dry-run`, and apply the reviewed migrations through that project's
   deployment workflow. Never run a push against an unrelated linked project.
3. Provision one dedicated backend login that inherits `kanto_api_runtime`;
   see [runtime-role setup](RUNTIME-ROLE.md). The migration creates a non-login
   permission group, not a password or service account credential. It grants
   game-table CRUD and the profile columns needed for account reservation,
   moderation and row locks. Browser roles do not inherit it. The login has no
   superuser, role/database creation, replication or RLS-bypass attribute, and
   no Auth-table access. Use its approved transaction-pooler connection string
   for `DATABASE_URL`, outside the checkout, mode 0600. Do not use the project's
   `postgres` password, a `service_role` membership, or a frontend `VITE_*` value.
4. Keep email confirmations enabled and choose exact redirect URLs. Use
   `http://127.0.0.1:5173` for local confirmation and
   `http://127.0.0.1:5173/account/recovery` for password recovery. A hosted client
   will need its own exact HTTPS URLs, API origin and WebSocket origin checks.
5. Configure custom SMTP for arbitrary player addresses. The default Supabase
   sender currently delivers only to organization team addresses, with a
   two-message-per-hour limit. It cannot support global player registration.
   SMTP credentials and the sending address/domain are still needed. See
   [Supabase SMTP documentation](https://supabase.com/docs/guides/auth/auth-smtp).
6. Populate the ignored root `.env` using `.env.example`; restrict its permissions
   to the operator. Restart the API and rebuild/restart the web client because
   its `VITE_*` settings are browser build inputs. Never expose a secret/service
   key through `VITE_*`.

## Hosted account acceptance

Use consenting test accounts to verify the real signup email, confirmation,
login, logout, recovery, case-insensitive name collisions, immutable handles,
and the two separate adventure slots. Verify an unconfirmed account cannot
start a session and an unrelated account cannot read another trainer's save.
Then repeat the battle/trade browser journeys using hosted accounts. The local
Auth `getUser` fixtures prove API integration and access checks; they do not
prove hosted signup or delivery.

Account setup does not qualify experimental game artifacts. Their public
capability flags stay false. Full adventure coverage, host/container resource
and permission limits, distributed routing, recovery and measured 1,000-player sizing remain
separate release requirements. No paid infrastructure or hosted schema change
has been made by this setup document.

## Native migration and runtime-role checks

Run a finite, fresh-tag check without starting Colima:

```sh
KANTO_MIGRATION_EVIDENCE_TAG=your-fresh-tag python3 -B scripts/run-local.py --allow-low-disk --min-free-gib 2 --wait-for-slot 600 -- python3 -B scripts/check-database.py --migrations
```

The launcher owns the existing project test cluster's lifecycle. The check
creates two new retained databases, applies migrations through CLI 2.111.0,
compares complete public/private schema dumps, and connects through an actual
restricted login. It checks trainer creation/name collision rollback, two
adventure slots, saved-session recovery, battle admission/release and an atomic
trade with a duplicate receipt. The session and save/ledger data are explicit
synthetic fixtures; this is a permission/persistence check, not original-game
or hosted-signup qualification. Browser roles, Auth-table access, handle
changes, unrelated/future tables, DDL, truncation and privilege escalation are
checked separately. The fixture login is disabled and the owned cluster stops
at the end; databases and logs remain retained.

Both passes are retained under `build/database-migrations-v1` and `-v2`.
The latter adds restricted-login battle/trade data-layer coverage. The CLI calls
use an explicit local Unix-socket URL and an unusable Docker endpoint; its
"remote database" log label does not indicate a hosted provider operation.
No remote schema, organization, project, billing or email setting changed.

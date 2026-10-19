# Shared Kanto accounts and multiplayer adventures

The persistent game API and gateway support the same Better Auth accounts as
the Netlify player. Partial or mixed Supabase/Better Auth configuration fails
at startup. The older Supabase mode remains available for existing isolated
prototype checks; it is not the hosted Kanto account source.

## Database identities and permissions

Migration `20261017125737_game-account-identities` expands the existing Kanto
database. It is applied in production in deploy `6ad37b8f326dd00660268d3e`
(`build/netlify-accounts-release-1792244496/published.json`). It preserves trainer names, slot UUIDs, uploaded flash and save
revisions. Generated UUID columns provide typed references to the existing
text account IDs. The account service has always generated UUID identities;
the migration explicitly rejects incompatible profile IDs.

`public.profiles` is a security-invoker view over `kanto_preview.profiles`, so
there is one immutable trainer name. Game records reference that account UUID
directly. No compatibility `auth.users` table, duplicate profile table, or
email-based identity matching is used. Each private adventure references the
complete reserved slot identity: UUID, owner, edition and slot number.

`kanto_game_runtime` is a non-login coordination role with forced row security
and explicit table permissions. It can read profile/slot metadata and manage
the private game records needed for two-player transactions. It cannot read
Auth tables, uploaded solo flash, or change names and adventure identities.
The account runtime cannot read private game records. New tables receive no
automatic runtime grant.

The `Database` adapter synchronizes slot metadata lazily and never copies an
uploaded cartridge into verified game storage. Three adventures per edition
share the reserved UUIDs across both interfaces. Native game sessions retain
their own checkpoints, journals and original flash.

## Server and browser configuration

Use separate restricted credentials to the **same dedicated Kanto database**:

| Variable | Purpose |
| --- | --- |
| `ACCOUNT_ORIGIN` | Exact Kanto account HTTPS origin; loopback HTTP is allowed for development |
| `ACCOUNT_DATABASE_URL` | Account connection with membership in `kanto_netlify_runtime` |
| `BETTER_AUTH_SECRET` | Existing Kanto-only account secret |
| `DATABASE_URL` | Game connection with membership in `kanto_game_runtime` |

Clear the two server Supabase settings for this mode. Keep secrets outside
source and browser builds. The API selects the Netlify identity adapter when
`ACCOUNT_ORIGIN` is configured. The account pool is bounded to two connections
per process, with connection/statement deadlines and explicit shutdown.

The adapter uses the [Better Auth Bearer plugin](https://better-auth.com/docs/plugins/bearer)
and SDK `getSession`, checking the session database for each authenticated
request. It requires a confirmed email and UUID identity and rejects expired
or revoked sessions. Initialization is lazy, so malformed credentials do not
open a database connection. The game service exposes verification only; signup,
recovery and email delivery stay at the account service.

The main browser build uses `VITE_ACCOUNT_PROVIDER=better-auth` and the reviewed
HTTPS game endpoint in `VITE_API_URL`. Its account requests use same-origin
`/api/cloud/` routes. Signup, confirmation, immutable name reservation, recovery,
logout and account-change cleanup use the actual SDK. Credentials remain in
memory, repeated game requests reuse them, and account switches invalidate
outstanding requests. Each game API request still receives server verification.
Neither localStorage nor sessionStorage stores the game token.

The WebSocket lease checks the same token on connection and renewal. It prompts
after ten minutes and expires after fifteen minutes; an open connection checks
revocation at renewal rather than receiving an immediate remote logout event.
The gateway needs only account credentials, without the game login or artifact
mount. CORS/origin checks still use the exact frontend origin.

## Adventure and navigation behavior

Session starts accept an explicit adventure UUID, checking ownership and
edition before disturbing an active worker. Ambiguous edition-only requests
are rejected. Adventure and trade bootstraps return their UUID; the browser
rejects a response for another selected adventure. Leaving the lobby resumes
that exact UUID. Saving after that return opens the adventure list; trade
scenes still return to the lobby.

The main shadcn interface displays each independent adventure and creates new
slots through the account service. During private qualification, its verified
progress is separate from uploaded solo progress. Existing solo saves are
preserved. This is not the final promotion policy for existing adventures, and
the main application is not yet the public site's entry point.

The public solo player's email/password fields stay mounted and retain typed
input during background anonymous-session refreshes. Auth notices appear in the active dialog or page, avoiding
duplicate messages. No public save is deleted, restarted or promoted by these
changes.

## Qualification

`build/netlify-accounts-check-1792254284929/report.json` records all six
versioned migrations on native PostgreSQL 18, actual SDK accounts, restricted
logins, row security, save revisions, multiple-slot races and desktop/mobile
cloud save load/export with the actual WASM worker.

Its `main-browser-report.json` runs the actual main UI, SDK and game API:
signup → confirmation → case-insensitive name collision → name reservation →
second FireRed adventure → original-C worker and verified inputs → save/exit →
password recovery and new-password login → account switching → two-account
battle challenge/acceptance → forfeit/result → lobby → exact adventure return.
Original cartridges and the other adventure remain unchanged. Repeated API
calls reuse memory credentials; no persistent token storage or page errors
were observed. Only client status admission is an explicit experimental
fixture; public manifest capabilities remain false.

`build/http-viewer-v8-battle-ui-report.json` separately completes the
full original-C match using those identities, the actual game schema and
independent restricted database transactions. It covers both viewpoints,
controller inputs, mobile touch, forfeit-prompt input blocking, renewal,
logout revocation, fresh-login recovery and unchanged adventure saves.
Cartridge fixtures are retained input-earned original saves, not client uploads.

The bounded HTTP transport also completes a full original-C match with actual
accounts, personal pictures, durable clock credit, retry receipts and rollback
after failed workers or SQL timeouts. The themed HTTP viewer, tab replacement
and fair handoff now pass desktop/mobile checks too. All six migrations are
applied in production deploy `6ad3a4e3ce306ae83fa3e14d`, including the explicit
game-role switch grant verified on the hosted preview. The hosted Function
and public viewer connection are unfinished. See [the HTTP qualification record](REQUEST-BATTLE-API.md).

The subsequent native Postgres contract passes exact-ID lobby recovery with
two same-edition rows. Ten desktop/mobile legacy UI regressions also pass.
The main UI loads game, lobby and battle screens on demand, with an accessible
loading state and recovery after a failed chunk download. Desktop/mobile built-
bundle checks pass in `build/main-screen-split-v2/report.json`. The controlled
production comparison in `build/main-production-comparison-v1/report.json`
reduces initial JavaScript from 439,441 to 358,180 bytes (18.5%).

The older `build/web-better-auth-v1` and `build/web-screen-split-v1` compilation
checks inherited development mode from their preceding Vite server. They are
not valid production-size baselines. The launcher now compiles in a fresh
production process. Builds with the deliberately invalid game endpoint remain
compilation checks, not deployable configurations.

All local launchers own their servers and stop them in `finally`. Test email
callbacks are captured locally. No hosted accounts or external emails are
created by these checks. Evidence, failed checks and source identities are
retained; no Docker/Colima startup or source commit is required.

## Remaining public-play work

1. Complete qualification of the [private hosted battle Function](NETLIFY-BATTLE-FUNCTION.md),
   including its advancing latency and actual viewer. The alternative is the current persistent
   HTTPS/WSS service, or a Netlify-compatible request-driven adapter that
   preserves original game behavior, private choices and durable recovery. See
   the [measured request-driven experiment](NETLIFY-GAME-EXECUTION.md).
2. Implement explicit promotion/admission of existing solo progress, preserving
   its provenance and player progress. Uploaded snapshots must not silently
   become verified achievement history.
3. Complete mechanics/audio, physical-device, crash/retry and measured mixed
   load qualification. Public-release and 1,000-active-player gates remain closed.
4. Continue the shared collection, community and DS work in
   [the platform direction](../PLATFORM-DIRECTION.md).

# Temporary Netlify accounts and cloud saves

This deployment keeps the source-built FireRed/LeafGreen browser player with confirmed email accounts and immutable case-insensitive trainer handles. Each account can keep three independent adventures per edition, each with an original-format 128 KiB flash save. Use the original game's SAVE command, then Account → Sync current game save. Continue downloads that adventure's flash, checks its hash, and boots the game at the title screen. Choose CONTINUE there. Unsynced progress stays in the open tab.

The implementation follows Design Hub's portable Better Auth/Postgres pattern. Netlify supplies static hosting, a thin modern Function and a dedicated Netlify Database. The email sender reuses the owner's verified Design Hub Resend account. Kanto has its own database, auth secret, sessions and profiles. No Design Hub or Jetlag database, user data or login secret is shared. All four Kanto runtime settings have Functions scope; the email key and auth secret are marked secret, with explicit production, deploy-preview and branch-deploy values. Secrets must not use the `all` context. `.netlify/` and `.env*` remain ignored.

| Variable | Setting |
| --- | --- |
| `BETTER_AUTH_SECRET` | Fresh Kanto-only random secret; secret and Functions scope |
| `RESEND_API_KEY` | Existing verified sender account; secret and Functions scope |
| `AUTH_EMAIL_FROM` | Kanto display name with the verified `mail.cg-designhub.com` sender |
| `AWS_LAMBDA_JS_RUNTIME` | `nodejs24.x`, Functions scope |
| `NETLIFY_DB_URL` | Managed automatically by Netlify for each database branch |

Do not copy a source project's database URL or auth secret. No Netlify Identity dashboard toggle is needed. The failed Jetlag email domain was not selected.

## Security and storage

`netlify/functions/cloud.mts` delegates to `apps/server/src/preview-cloud.ts`. The handler accepts only Kanto's production hostname or its immutable deploy hostname, overwrites client IP using the platform context, and returns private responses with `Cache-Control: no-store`. Better Auth requires email confirmation and a minimum 12-character password, stores hashed passwords, uses HttpOnly cookies, revokes sessions after password recovery, and persists rate limits in Postgres. The platform also limits requests by IP and domain.

The SDK-generated Auth tables and Postgres-specific role, grants and row policies live in the versioned Netlify migration. Netlify applies this file during deployment. Do not run hosted DDL manually or edit an applied migration. The server uses a non-login restricted role for auth queries and save transactions. Save transactions set the confirmed session owner locally, with forced row security. Handles cannot be renamed or deleted by the runtime. Browser requests cannot choose an owner. Saves use revisions and server-computed SHA-256 hashes; stale writes fail rather than replacing a newer save, and identical retries are accepted.

Cloud slots are isolated in `kanto_preview`, separate from authoritative multiplayer data. Browser-uploaded saves are not verified battle or trade progress. The temporary app does not provide global multiplayer yet.

The second migration gives each adventure an immutable UUID and a slot number from zero to two. Existing saves keep their bytes and revision in slot zero. `/api/cloud/adventures` creates the next empty slot under a database uniqueness constraint; `/api/cloud/adventures/{uuid}/save` reads or updates that exact adventure. Legacy `/api/cloud/saves/{edition}` addresses only slot zero. Ownership remains enforced by forced row security, and runtime column grants exclude identity and slot changes. Guest games can sync only to an empty slot; a loaded adventure stays bound to its UUID and current worker boot.

The third migration, `20261017125737_game-account-identities`, adds the shared profile view and restricted private game tables. It preserves every cloud slot, name and uploaded save. The account role cannot access private game records; the game role cannot read Auth tables or uploaded solo flash. See [identity and main application qualification](BETTER-AUTH-MULTIPLAYER.md).

The fourth migration, `20261017140706_request-driven-battles`, adds private request clocks, personal input queues and response receipts for the locally qualified HTTP battle transport. It also indexes adventure-owner UUID lookups. Applying it does not expose an HTTP battle Function or promote uploaded solo progress.

The fifth migration adds durable tab connections and fair request handoff. The sixth grants the managed deployment connection permission to SET the game role without inheriting it. The account role remains isolated. Hosted probes verify the restricted transaction and production writer's grants. The [private battle Function](NETLIFY-BATTLE-FUNCTION.md) now uses the explicit `{managedGameRole:true}` database mode, which scopes every query and transaction to that role. Its actual hosted journey passes. The default persistent `Database` mode still requires already-restricted credentials; never pass the managed owner URL to that default mode. Production retains six migrations; the separate battle preview also applies the seventh matchmaking migration.

Solo workers skip unused verification journals and their periodic state hashing. Verified multiplayer workers retain the default journal path. The browser caches hash-verified WASM files by content identity with a bounded cache and a download fallback. Actual C-worker comparison checks equal frames, pixels and saved flash across both journal modes; browser checks cover cache reuse, corrupt-cache repair and separate adventure selection.

## Local validation and deployment

Run finite jobs through `scripts/run-local.py` as described in the README. A release check uses:

```sh
KANTO_NETLIFY_ACCOUNTS=1 KANTO_PREVIEW_CANDIDATE=battle-text-audio-16 \
  KANTO_PREVIEW_OUTPUT=build/netlify-adventures-v2 \
  node --experimental-strip-types scripts/build-preview.ts
KANTO_PREVIEW_OUTPUT=build/netlify-adventures-v2 \
  python3 -B scripts/check-database.py --netlify-preview
node node_modules/typescript/bin/tsc --noEmit
```

The database check owns a fresh small native PostgreSQL 17 cluster, retains its files, and stops it in `finally`. It does not start Docker or Colima. Actual SDK signup/confirmation/reset/logout and restricted-login RLS checks precede desktop/mobile browser tests against the built UI and real WASM worker. Tests capture email callbacks locally and reuse retained input-earned original-game saves; they send no external emails and do not run another story playthrough.

The current bundle is `build/netlify-request-battles-v1`; the example uses a fresh output directory because the builder preserves previous bundles. The latest complete qualification is `build/http-viewer-v8/report.json`; component reports are in `build/netlify-accounts-check-1792254284929/`. It covers all six migrations on PostgreSQL 18, matching the hosted database major, a full original-C HTTP match, the themed desktop/mobile HTTP viewer, fair handoff, tab replacement, the main account/adventure UI, the existing socket battle and solo-save regressions. Earlier PostgreSQL 17 evidence is retained separately. These local checks do not qualify hosted battles. The public solo account form stays mounted across background anonymous-session refreshes; a deterministic desktop/mobile regression verifies both credential fields retain their DOM nodes and values while the SDK refresh is pending.

`scripts/stage-netlify-preview.ts` creates a bounded, credential-free deploy bundle at `~/.local/share/kanto-netlify-accounts-v1`, explicitly linked to site `4fcf6389-9abb-4239-8134-d99fa08b85d8`. `.netlify/` is ignored in this staging folder too. It bundles the Function and copies only the browser assets and migrations, with a hash manifest. It refuses to overwrite a prior public bundle; `--retain-previous` verifies and moves the prior files into `retained/` first. The staging package declares `@netlify/database`; Netlify Build provisions the database and packages migrations. Use a normal build-backed draft deploy first, then production after validation. `--no-build` would skip that database preparation.

`scripts/deploy-netlify-accounts.py` checks source hashes against the latest successful native/browser report, deploys the staging bundle to a preview, runs hosted API and desktop/mobile gameplay checks, and then deploys to production and checks its API and migration status. Run it through the same resource guard. It stops before the next phase on failure and retains private command logs and a release report. Inspect the deployed database with `netlify database status --branch production --json`; omitting `--branch` checks a local development database, and `main` is not the production database identifier.

```sh
netlify deploy --site 4fcf6389-9abb-4239-8134-d99fa08b85d8 --context deploy-preview --alias kanto-account-check --json
netlify deploy --site 4fcf6389-9abb-4239-8134-d99fa08b85d8 --context production --prod --json
```

Run these CLI commands from the isolated staging directory to avoid the root monorepo workspace picker. There is no Git continuous deployment configured. No source commit or push is needed for this manual deployment.

The current release is production deploy `6ad3a4e3ce306ae83fa3e14d`, published October 17, 2026 at 16:40:12 UTC. Evidence is retained under `build/netlify-accounts-release-1792255070/`: the release report, exact public-bundle check in `published.json`, explicit production-branch migration check, and hosted role checks in `preview-game-runtime.json` and `production-game-runtime.json`. All six migrations are applied. Four hosted gameplay checks cover both editions on desktop/mobile before publication. The public entry point remains the solo player; applying the private schema does not enable public multiplayer.

## Moving later

The account service uses standard Request/Response and Postgres. Move its thin platform wrapper, export/import this dedicated database through the supported provider workflow, retain the auth secret securely, and configure a new verified email sender/domain as needed. Moving to a different domain requires users to log in again because cookies are host-bound. No user data is tied to Netlify Identity or Blobs.

The existing WebSocket game transport requires a persistent host such as OrangeHost. A [bounded HTTP battle adapter](REQUEST-BATTLE-API.md) now completes a full original-C match locally with actual accounts and restricted PostgreSQL. It persists clock credit and personal controls, commits progress with retry receipts, and recovers failed workers without changing original adventure saves. Its browser viewer passes local checks; the hosted Function and public viewer connection are unfinished. The [integration record](BETTER-AUTH-MULTIPLAYER.md) distinguishes local qualification from public availability. Preview-uploaded saves still require an explicit verification/promotion policy. The Caddy/Compose configuration remains the later-host starting point. The 1,000-active-player capacity goal remains unqualified.

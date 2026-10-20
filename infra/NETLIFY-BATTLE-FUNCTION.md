# Private Netlify battle Function

The original-C battle backend runs on Netlify in a private qualification
preview. Production remains the solo player, with six applied migrations.
No public battle viewer, save promotion, ranked progress or capacity gate has
been enabled.

## Implemented boundary

`netlify/functions/battles.mts` accepts only this site's immutable deploy
hostnames in a preview context. Production and branch aliases are rejected.
The handler delegates to the same authenticated Request/Response transport
exercised by the native HTTP suite. Every call revalidates the confirmed SDK
session and reserved trainer identity.

The managed database URL is never used directly for game SQL. `Database` with
`{managedGameRole:true}` wraps both ordinary queries and explicit transactions
in `BEGIN` / `SET LOCAL ROLE kanto_game_runtime` / commit or rollback, with two
connections. Account verification uses a separate two-connection pool. Native
checks reproduce a privileged non-superuser login, denied Auth/solo-flash
reads, concurrent queries, failed SQL and clean connection reuse.

The private runtime contains a bundled Node 24 worker and two pinned original
battle cores. Both manifests keep their experimental public capability flags.
Admission checks edition, ABI, upstream revision, artifact identity and SHA-256.
The runtime lives outside the publish directory and is explicitly included in
the Function bundle, following [Netlify's file configuration](https://docs.netlify.com/build/configure-builds/file-based-configuration/).

The first hosted preview constructs a new worker per request. The current
locally qualified optimization reuses one idle worker's artifact/baseline
cache. Each request owns one console scope; normal close destroys its player
consoles and abort terminates its own lease. A delayed old scope cannot kill
another request's lease. Checkpoints, clocks and receipts remain authoritative
in SQL. Cold restoration is required and tested; a warm cache is optional.

## Evidence and exact scope

- Initial complete native qualification: `build/netlify-battle-function-v3/report.json`.
- Current native qualification: `build/netlify-accounts-check-1792502730677/report.json`
  (PostgreSQL 18, battle UI and request-driven HTTP proofs).
- Initial hosted preview deploy: `6ad3b4d874d22a33435abe77`, branch `kanto-battle-check`.
- Current hosted branch deploy: `6ad7729b8764ebc36c75b76c`, branch and database
  branch `kanto-battle-check`, eight applied migrations, zero pending.
- Current hosted proof: `build/netlify-battle-preview-6ad7729b-hosted.json`
  (480 frames; 2,743.5 ms median, 3,087 ms p95, 3,187 ms maximum per step).
- Archived source and closeout: `build/netlify-battle-preview-1792259283/`
  `qualified-source/` and `completion.json`.
- Current optimization qualification: `build/netlify-battle-warm-v2/report.json`,
  with components in `build/netlify-accounts-check-1792259862358/`.

The hosted test creates two new fixture accounts through the real SDK against
the isolated preview database. Confirmation callbacks are captured locally;
hosted email delivery is not exercised. It then performs actual hosted login,
profile reservation, challenge, acceptance, inputs, exact reply replay, tab
replacement, atomic forfeit and logout rejection. An independent local original
core restores the hosted checkpoint and matches the personal response pixels.
The test advances 468 frames and preserves both canonical cartridges. It does
not qualify a full hosted match or the hosted browser viewer.

The full native HTTP test completes 10,076 frames against its independent
reference, including failure/retry and both browser viewports. That extended
journey uses the cold worker path and a recorded server-clock fixture; a
separate test uses real database time. The new scope tests independently cover
state clearing, reused workers, stale aborts and cold recovery after an
in-flight worker kill. The main app, socket battle and solo checks also pass.

The initial hosted sample had eight advancing requests: 3,489.5 ms median,
3,558 ms maximum. The current branch preview advanced 480 frames; step latency
is 2,743.5 ms median, 3,087 ms p95 and 3,187 ms maximum. This is still too slow
for public multiplayer; the preview is test-only.

## October 20 branch preview

The optimized preview now deploys as a real branch deploy:
`6ad7729b8764ebc36c75b76c` on `kanto-battle-check`, database branch
`kanto-battle-check`, eight applied migrations and zero pending. The hosted
proof passed with two SDK-created accounts, an original-C worker, exact
lost-reply retry, tab-replacement fencing, checkpoint and personal-picture
parity, unchanged canonical cartridges, atomic forfeit and logout revocation.
Production HTML remained byte-identical; production keeps six migrations.

Two operational causes were found and fixed:

- `--context branch:kanto-battle-check` alone created a deploy preview with
  `database_branch_id: null`. The CLI creates a real branch deploy with
  `--context deploy-preview --alias kanto-battle-check` only after the staging
  folder has a local Git branch with that name. The unsafe previews without a
  database branch were deleted.
- The Function zip exceeded the 250 MB limit because the staging `retained/`
  directory was swept into the bundle (434 MB uncompressed, 201 MB zipped).
  Moving the retained bundles outside the stage reduced the zip to 27 MB.

The previous opaque `Error while running build` was this size limit;
`netlify deploy --verbose` surfaced the real `JSONHTTPError`.

The seventh matchmaking migration was corrected before its first hosted
application: foreign keys reference `kanto_preview.profiles(account_uuid)`,
because `public.profiles` is a view. It is applied on `kanto-battle-check` only;
it must now be treated as immutable. This does not qualify public matchmaking.

Before public admission, finish hosted viewer/failure/performance checks,
bounded concurrency and retention, audio, physical-device playback, and the
explicit provenance-preserving admission of solo adventures. Verified adventure
and trade request adapters, cross-generation conversion, collection history,
leaderboards and 1,000-player capacity remain separate work.

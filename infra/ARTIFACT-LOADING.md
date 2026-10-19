# Loading shared game files

Fresh adventures now discover, download and verify the common game file before
calling `POST /api/sessions`. A slow game-file download therefore does not reserve
a private adventure worker or consume its loading deadline. The browser then
downloads its authenticated checkpoint and starts verified play. If the claimed
bootstrap names a different file after a deployment, that bootstrap's hash takes
priority and the browser downloads the matching file. The game worker retains
its independent integrity check. Existing lobby/trade bootstraps already carry
their file URL and use the same verified download helper.

`GET /api/engines/:version/manifest` discovers the currently admitted manifest
and remains `no-store`. Shared bytes use
`/api/engines/:version/:sha256.wasm` with a public, immutable one-year cache
header. The server refuses a hash that does not match its loaded manifest.
The old mutable `/artifact` URL remains available with `no-store` for existing
clients. Neither route changes game admission or candidate capability flags.
Checkpoints, profiles, account data and other API responses remain uncached.

Both download routes share an exact view of the registry's immutable byte
allocation instead of copying the entire file per request. Byte offset and
length are retained, including for views into a larger allocation. Registry
artifact bytes must remain immutable while requests are being served.
The response-allocation check runs eight real HTTP downloads per route for
both full-size games, verifies all wire hashes, and observes one backing
allocation per file across the responses. Aborting a download leaves the
artifact and later downloads intact. This observation measures response
backing allocations, not total RSS, physical RAM or 1,000-player capacity.

Large responses are not always retained by the browser's ordinary HTTP cache.
The app also uses the `kanto-game-artifacts-v1` Cache Storage namespace for
verified, content-addressed game files. Every cache read is checked against the
expected SHA-256. A corrupt entry is discarded, and a network integrity mismatch
gets one reload attempt before an error is shown. At most four game-file entries
are kept by this loader; pruning affects only matching game-file URLs in its own
namespace. It never puts a checkpoint, save, token or profile into that cache.
Unavailable storage or a failed cache write falls back to downloading. Browser
eviction, unsupported storage and quota pressure can require another download;
this is not an offline-play or save-persistence guarantee.

Local verification includes real Chrome fetching both approximately 13.5 MB
original game files. In that fresh context, the raw HTTP cache fetched each file
twice. The application cache's second read made no fetch, recovered from an
injected corrupt entry, stayed bounded at four entries, and continued when cache
access was disabled. These checks use native Cache Storage without request
interception or a service worker. Real quota exhaustion is not induced.

The original-C browser journey separately holds game-file delivery and verifies
that no session-claim request or session-row mutation occurs until delivery is
released. It covers both editions on desktop/mobile, then exercises audio,
lobby entry, save/exit, reconnect and checkpoint recovery. Its request routing
disables the ordinary HTTP cache, so it does not serve as HTTP-cache proof.
Two-player trade coverage checks the new immutable URLs through the original
scenes and atomic saves. Local Auth fixtures do not qualify hosted accounts.

The qualification page now retains one React root, as the battle and trade
qualification entries already do. Earlier attempts recorded a duplicate game
connection taking over another connection from the same page. Those attempts,
socket diagnostics and source snapshots remain in `build/`.

Hosted CDN behavior, cross-region latency, physical devices and global capacity
remain unqualified. No hosted backend or public Netlify preview is changed by
these local checks.

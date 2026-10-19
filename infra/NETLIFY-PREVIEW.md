# Netlify browser preview

The separate `kanto-online-preview` Netlify site publishes temporary solo play at
https://kanto-online-preview.netlify.app. The new [account deployment](NETLIFY-ACCOUNTS.md)
adds confirmed email accounts and solo cloud saves to this player. Use the original
game SAVE command, then Account → Sync current game save. Unsynced progress is lost
on reload. Authoritative multiplayer is still separate.
The experimental audio build supports the shadcn Sound control, muted by default.
Original-GBA audio fidelity and full adventure coverage remain unfinished. No
public release gates change.

`scripts/build-preview.ts` packages only the preview HTML, browser worker and UI,
two hash-checked 16 MiB experimental cores, and newly generated empty-game
bootstrap checkpoints. It does not copy application environment files, user saves,
server data, reference ROMs, vendor sources or the application artifact registry.
The existing verified worker restore and artifact integrity checks are preserved.
Quick button taps remain pending until a simulation tick consumes them.

The static-only reproduction instructions below describe the earlier player build.
For the current account deployment, use [NETLIFY-ACCOUNTS.md](NETLIFY-ACCOUNTS.md);
a static-only deploy would omit the account API and database migration packaging.

Build after producing both `build/game-source/{firered,leafgreen}/battle-text-audio-16`
candidates. This deployment uses local artifacts; a fresh Git checkout must build
the pinned source candidates first. It is not configured for Git continuous deployment.

```sh
KANTO_PREVIEW_CANDIDATE=battle-text-audio-16 KANTO_PREVIEW_OUTPUT=build/your-preview python3 -B scripts/run-local.py --allow-low-disk --min-free-gib 2 --wait-for-slot 600 -- node --experimental-strip-types scripts/build-preview.ts
python3 -B scripts/run-local.py --allow-low-disk --min-free-gib 2 --wait-for-slot 600 -- node --experimental-strip-types scripts/check-preview-package.ts build/your-preview your-preview
KANTO_PREVIEW_CANDIDATE=battle-text-audio-16 KANTO_PREVIEW_OUTPUT=build/your-preview KANTO_UI_EVIDENCE_TAG=your-preview KANTO_AUDIO_EVIDENCE_TAG=your-preview KANTO_PREVIEW_RELEASE_AUDIO=1 python3 -B scripts/run-local.py --allow-low-disk --min-free-gib 2 --wait-for-slot 600 -- node node_modules/@playwright/test/cli.js test --config playwright.hosted-preview.config.ts
```

Always pass the dedicated site ID explicitly; the parent workspace may be linked
to an unrelated site. `.netlify/` is ignored. The deploy publishes only
the explicitly chosen output directory, with no functions or hosted account
dependencies. Choose a fresh directory and evidence tag: the builder refuses to
overwrite retained output. The legacy `KANTO_AUDIO_PREVIEW=1` and default
`memory-16` selectors remain available for historical reproductions. New preview
releases explicitly select the repaired `battle-text-audio-16` cores.

`scripts/check-preview-package.ts` matches each WASM's full hash against the
joined first-gym evidence and decodes each public checkpoint against a newly
created same-seed engine. It requires frame zero and empty cartridge data. Its
file allowlist excludes reference ROMs, saves, environment files, source maps
and backend files. Keep its report outside the publish directory.

To verify the account-enabled public player with fresh headless Chrome:

```sh
KANTO_NETLIFY_ACCOUNTS=1 KANTO_PREVIEW_URL=https://kanto-online-preview.netlify.app KANTO_PREVIEW_CANDIDATE=battle-text-audio-16 KANTO_UI_EVIDENCE_TAG=your-live-tag KANTO_AUDIO_EVIDENCE_TAG=your-live-tag KANTO_PREVIEW_RELEASE_AUDIO=1 python3 -B scripts/run-local.py --allow-low-disk --min-free-gib 2 --wait-for-slot 600 -- node node_modules/@playwright/test/cli.js test --config playwright.hosted-preview.config.ts
```

The checks boot both actual WASM workers in desktop and mobile Chrome emulation,
measure real Web Audio graph output, check multi-frame sample counts and bounded
buffering, exercise repeated Sound toggles and pause/resume, clear audio on the
original reset chord and restart, and ensure no local bootstrap or application
API beyond the account endpoint is requested. The mobile HTTPS cases use touch input.
This does not establish physical-device coverage or hosted multiplayer capacity.
The combined release suite also checks keyboard/touch input, pause/resume,
controls-guide focus, the FPS overlay, edition selection and desktop fullscreen.
It runs eight cases across both editions and desktop/mobile Chrome emulation.

The player UI now uses the shared shadcn/ui components and Tailwind theme in
`apps/web/src/theme.css`. The same button, input, selector and dialog components
are used by the account, adventure, lobby, battle and trade screens. See
`apps/web/src/components/README.md` for component conventions. Preview controls
include top chrome, edition colors, a keyboard guide, fullscreen and an optional
FPS/frame-interval/simulation-speed overlay and Sound. The original candidates
are retained unchanged; the separate audio candidates have new pinned WASM
identities and corrected audio synthesis timing. See `engine/AUDIO.md` and
`build/audio-browser-validation.json` for evidence and its scope.

The [first-gym repair and coverage](../engine/BROCK.md) document the new cores.
Their complete movies pass in browser workers and their saves load in the
unchanged original GBA games. Full-game and hosted-multiplayer release gates
remain closed.

The October 17 UTC deployment `6ad2d14a10a5e8cbf9d304e1` publishes the repaired
cores. Its permanent URL and the main URL each pass all eight release cases;
the HTML and both boot metadata files match the locally tested package. The
Netlify file index matches all 13 payload files by hash and includes one extra
deploy configuration entry, which returns HTTP 404 from the public site.
Receipts, file hashes and browser logs live under `build/brock-ui-*`.

The player-feedback deployment `6ad2ee6c09629acf1d91981a` adds a shadcn restart
confirmation that pauses play, preserves the current worker on Cancel/Escape,
and starts a fresh selected edition only after confirmation. A Session only
badge explains temporary progress beside the game. Mobile controller buttons
are at least 44px. Both account and preview builds pass local UI checks; account
save/connection messages are qualified against the local server and Postgres.
The public deploy remains the solo preview; it does not deploy that backend.
Deployment and live-check receipts are retained under `build/player-feedback-*`.

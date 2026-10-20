# Roadmap

The direction and acceptance gates live in
[`PLATFORM-DIRECTION.md`](PLATFORM-DIRECTION.md). This page is the current
execution order. GitHub issues are the source of truth for each work item.

## Now

The opt-in spectator and lobby live-list slice is implemented locally:

- per-battle `watchable`, default `false`, set by the challenger;
- quick match always private;
- `WATCH_DISABLED` for a private battle;
- `/api/battles/live` requires a live, unsuspended lobby session and only lists
  active opted-in battles;
- schema, Supabase migration, Netlify migration, UI toggle and tests;
- reload continuity: quick-match state is restored from the server, and an
  active battle or committing trade is surfaced on the adventure screen with a
  one-click return to the lobby.

Local verification is complete: `npm run typecheck`; the unit suite
(132 tests, 131 passing, one skip); the database contract lane; the full
migration chain with schema parity (`build/database-migrations-v4-watchable`);
the original-C engine lane (`build/battle-service-report.json`, with
`spectatorOptInEnforced`, `liveListRequiresLobby` and `liveListWatchableOnly`
all true); and the browser lanes (`build/web-watchable`, 12/12, and
`build/web-quick-resume-v2`, 14/14, on desktop and mobile plus the production
compile).

After local verification, the next gate is
[#1 Hosted staging qualification](https://github.com/kurosh87/fired-multiplayer/issues/1).
Staging is offline by owner decision; do not restore it or apply migrations
without explicit approval.

## Next

- [#3 Hosted trade scene execution](https://github.com/kurosh87/fired-multiplayer/issues/3)
- [#4 Measured 1,000-player capacity](https://github.com/kurosh87/fired-multiplayer/issues/4)
- [#5 Physical-device and cross-browser qualification](https://github.com/kurosh87/fired-multiplayer/issues/5)

## Conditional or later

- [#2 Request-driven battle spectating](https://github.com/kurosh87/fired-multiplayer/issues/2)
  if the hosted rollout uses the request-driven viewer.
- [#6 Normalized-level and ranked formats](https://github.com/kurosh87/fired-multiplayer/issues/6)
  after unranked multiplayer is stable.
- Community progression, shared Pokédex and cross-generation transfer per
  `PLATFORM-DIRECTION.md`.

## Launch gate

[#7 Public unranked multiplayer launch gate](https://github.com/kurosh87/fired-multiplayer/issues/7)
tracks the required gates. Capability flags stay off until every required box is
checked and a separate rollout is approved.

## Guardrails

- No production migrations or capability-flag flips without explicit approval.
- Preserve save, battle, trade and ownership invariants over availability.
- Keep ignored game artifacts (`*.gba`, `*.sav`, `*.wasm`, `*.elf`, `build/`,
  `test-output/`, `vendor/`) out of the public repository.
- Local qualification is evidence, not a public release decision.

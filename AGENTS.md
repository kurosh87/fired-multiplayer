# Kanto Online workspace

Follow `/Users/pejman/AGENTS.md` and run finite build/test/install jobs through
`scripts/run-local.py`. Preserve the shared lease, pressure, swap and growth
checks. Do not commit or push unless the user requests it.

## Native database and evidence retention

Native Netlify checks use `build/qualification-postgres/<timestamp>/`.
These directories contain retained qualification evidence. Their
`.kanto-native-owner.json` records the active launcher, its start identity and
the owning guard. Do not remove, replace or compress an active directory.

Any future cleanup must acquire the shared build lock and the project lock
`build/.native-qualification.lock`, recheck the owner PID/start identity and
PostgreSQL status immediately before each operation, and have approval for
the exact retained targets. One empty lsof scan does not prove a test directory
will remain inactive. Never delete these directories through a wildcard.

An external cleanup on October 17 removed an active legacy
`build/postgres-netlify-*` directory during a guarded test. The incident receipt
and prior logs are retained; new checks use the protected namespace above.
Preserve reports, screenshots, original earned saves, source snapshots and
compiled candidates. Regenerable intermediates still need an explicit
retirement decision; their classification is not deletion authorization.

## Public capabilities

The public Netlify player is currently solo play with accounts/cloud saves.
HTTP multiplayer, additional migrations and runtime code require their actual
qualification before public admission. Do not flip engine capability flags or
promote uploaded saves into verified achievement history to bypass a gate.

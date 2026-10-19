# Game connection lifecycle

Closing an adventure socket now pauses its verifier, waits for already accepted
input, writes the packed checkpoint, closes the private engine and returns its
slot to the bounded pool. A conditional database update increments the old
writer fence and expires its lease. The adventure stays resumable; disconnect
does not mirror cartridge flash, advance a save revision or close the durable
adventure record.

Previously the socket close handler only checkpointed. Its resident verifier
kept a worker slot until that player returned or the API restarted. Enough
departed players could therefore exhaust the pool despite no active sockets.
An idle worker process may remain warm with its artifact cache; returning a slot
does not prove that all process RSS was returned to the OS.

Retirement takes the same per-owner lock as start, exit and lobby transitions.
Duplicate closes are harmless. A late close from an older connection cannot
retire a replacement in the same API instance. Conditional checkpoint writes
and the incremented fence prevent a delayed pause request from renewing or
overwriting a replacement on another service instance. A checkpoint failure
still closes the engine and attempts to revoke the lease; the preceding
checkpoint and durable journal remain the recovery source. A database outage
can delay reacquisition until the old lease expires; no successful release is
claimed when its database write fails.

Shutdown drains owner operations already running, rejects starts queued before
shutdown, and serializes the remaining retirements. It retains the existing
fencing protection against checkpoint writes already outside the owner lock.
Abrupt API loss still uses the sixty-second durable ownership lease.

Both adventure/trade and battle routes send protocol-level WebSocket pings every
thirty seconds. A peer that has not answered the prior ping is terminated on the
next interval, normally within sixty seconds of its last response. This invokes
the ordinary close/cleanup path. Pongs need no game frames or JavaScript timer;
healthy paused browser connections remain open. Event-loop stalls or a failing
database can delay detection or retirement, so this is not a hard wall-clock
service guarantee. Ping write failure also terminates the transport. Socket
close removes its interval and listeners.

The local one-slot Postgres contract checks capacity before/after disconnect,
immediate cross-service recovery, acknowledged progress, stale closes, delayed
checkpoint writes, injected checkpoint failure and shutdown with a queued start.
Its engine is an arithmetic fixture. Controlled-clock heartbeat tests also use
real WebSocket ping/pong frames and a peer configured not to answer. Original-C
browser and actual API crash/restart journeys provide separate gameplay proof.

Bootstraps that never reach an authenticated play socket are eligible for the
same checkpoint-and-retire path after sixty seconds. A monotonic connection
clock tracks this loading deadline independently of the verifier's game-time
budget. The API checks every five seconds with at most one sweep running.
Cleanup rechecks the exact runtime under its owner lock, so a connection or
replacement that arrived while the sweep waited is kept. Shutdown stops the
interval and waits for a pending sweep before closing the services/database.
Checkpoint requests do not extend the loading deadline. As with the existing
sixty-second ownership lease, a very slow or interrupted load may need to be
opened again; this change adds no download-completion guarantee.

The bootstrap contract uses real Postgres and a one-slot pool. It covers the
deadline boundary, preserved recovery state, frame-clock isolation, attached
paused players, connection/rebootstrap races and actual API interval wiring.
Only its connection clock is advanced; the API interval runs on the real event
loop. This is separate from a minute-long loading/network soak.

Global admission and cross-machine routing remain unfinished. A healthy
connected player who remains paused keeps their slot; no idle-player eviction
policy has been selected. Hosted behavior and 1,000-player capacity have not
been qualified.

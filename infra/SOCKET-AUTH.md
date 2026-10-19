# Authentication during longer game sessions

The API previously closed every adventure/trade and battle socket after fifteen
minutes, including connections whose browser account was still valid. Authenticated
connections now request fresh authorization after ten minutes. The browser uses
the existing Supabase `getSession()` token helper to answer over that same socket;
the API reuses `getUser(token)` and the profile suspension check. The browser's
locally stored session is never accepted as proof of authorization by the server.
See [getUser](https://supabase.com/docs/reference/javascript/auth-getuser).

Control messages use protocol 1:

```json
{"type":"auth-required","protocol":1}
{"type":"refresh-auth","protocol":1,"token":"CURRENT_ACCESS_TOKEN"}
{"type":"auth-refreshed","protocol":1}
```

The first and last messages come from the API. The middle message comes from the
authenticated browser. No session ID, frame, buttons or game state is accepted
in the refresh message. Tokens never enter URLs. Renewal requires the same
confirmed account and a currently permitted profile. It changes only the
authorization deadline, leaving the game fence, epoch, input sequence, digest,
clock credit, pause state and sound state untouched. Adventure and trade share
one socket route; battle pixels remain on the separate battle route.

No response within fifteen minutes of the last successful authorization closes
the socket. Browser credential lookup has a ten-second deadline. Each connection
permits at most one refresh attempt per minute; malformed refresh messages and
authorization failures close it. Queued game commands cannot run after a failed
authorization. A delayed Auth response cannot renew a closed/expired lease.
Timers and browser listeners are disposed on socket close or screen unmount.
Older clients that do not answer the new prompt retain the fifteen-minute
reconnect behavior; deploy the API and authenticated web app together.

Clock-controlled tests exercise multiple renewals past the original deadline,
silence expiry and late-response races. Real WebSocket route tests use an
isolated Auth HTTP fixture to verify account changes, expiry, unconfirmed email,
suspension, invalid fields and throttling. The native PostgreSQL contract checks
that a successful adventure renewal changes no checkpoint, fence or sequence.

Original-C browser qualification separately delivers the prompt as a native
browser `MessageEvent`, then observes its real response over the production
WebSocket route in desktop/mobile adventures, a two-player battle and both
paused original trade scenes. Renewal leaves the trade scene checkpoint,
fence and input sequence intact; the journey then exercises audio cleanup,
reload recovery and atomic saves. This
avoids a ten-minute wait for each UI case; it does not establish hosted Supabase
token rotation, SMTP delivery or a multi-hour wall-clock soak. Those remain
hosted acceptance work.

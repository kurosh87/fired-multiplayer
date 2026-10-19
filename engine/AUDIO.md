# Original C audio output

The existing FireRed and LeafGreen 16 MiB candidates already generate stereo
PCM in their compiled portable C mixer. Neither candidate currently exposes a
public audio-output ABI, and the browser worker does not play these samples.
Audio capability flags remain false. Separate `audio-16` experimental builds
now expose an output-only audio ABI and support the preview's shadcn Sound
control. The retained `memory-16` candidates remain unchanged.

## Experimental playback implementation

`kanto_audio_abi_version()` is 1. Its read-only exports provide the sample
pointer, current interleaved float count, capacity (4,096 floats), two channels,
effective sample rate, nominal mixer rate and the actual initialized driver
rate. They never clear output or advance the game.

`link-candidate.py --audio-experiment --memory-mib 16` retains this build in
`build/game-source/{firered,leafgreen}/audio-16`. It recompiles the original
`m4a.c` and `sound_mixer.c` with a reviewed pre-include that sets synthesis to
41,869 Hz, the nearest integer to 701 samples per original frame. No vendor
source or original GBA baseline is modified. Output playback uses the exact
effective rate, approximately 41,868.978 sample frames per second.

The worker collects each simulated frame when sound is enabled, including
ticks containing multiple frames. Audio has its own message and never enters
the verified input protocol. The preview schedules bounded stereo buffers on
Web Audio, using the device's normal output resampling. Sound starts muted
and requires a user gesture. Pause, mute and preview restart stop queued
sources; the original reset chord also clears pre-reset audio. Tooltip
rerenders preserve click handlers through DOM event listeners.

The playback implementation uses native [AudioBufferSourceNode scheduling](https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode/start).
It caps queued sources and time, rebuffering after a stall instead of allowing
an unbounded backlog. Output timing does not advance or pause the game.

`scripts/check-audio-candidate.ts` verifies bounded PCM and actual driver rate,
read-only audio observation and 480 frames of checkpoint/batch parity. It also
replays each complete PC-storage movie. Both saved cartridges for each edition
are byte-identical to the previously original-GBA-qualified saves. This is
save/gameplay evidence, not an original GBA audio comparison.

The full desktop/mobile worker replays with audio enabled retain their reports
under each audio candidate. Their worker source predates the final output-only
warm-reset queue flush; that exact source is retained in
`build/audio-before-soft-reset/source/game.worker.ts`. Final preview tests cover
the queue flush, real Web Audio graph output, multi-frame packet lengths,
bounded buffering, tooltip rerenders, pause acknowledgement, mute and restart.
Physical devices and independent GBA audio fidelity remain unqualified.

The HTTPS-tested build is published at
[kanto-online-preview.netlify.app](https://kanto-online-preview.netlify.app).
Choose an edition, start the preview, then enable Sound. The consolidated
evidence is `build/audio-browser-validation.json`, which pins the published
bundle, both candidate identities, four full-route viewport replays and four
local plus four HTTPS playback cases. The mobile HTTPS cases use touch input.
The site's HTML and bootstrap metadata match the tested build.

For a matching static build, use `KANTO_AUDIO_PREVIEW=1` with
`KANTO_PREVIEW_OUTPUT=build/netlify-audio-preview` when running
`npm run build:preview` through the project guard. Keep deployment's explicit
site ID and publish directory; the default build still selects the retained
non-audio candidates. All audio candidate capability flags remain false while
broader fidelity, hosted accounts and battle integration are unfinished.

## Authenticated Game integration

The React Game screen now consumes the same bounded playback helper and
output-only worker messages. Its shadcn Sound button starts muted, enables
playback through a user gesture, and stays disabled for older cores without
the audio ABI. Pause, backgrounding, lobby entry, exit and connection failure
stop queued sound immediately. Unmount closes its AudioContext; returning
creates a fresh context. A playback error leaves gameplay available.

The opt-in `tests/audio-game-ui-qualification.ts` exercises both editions at
1440px desktop and 390px mobile against the real original-C verifier, HTTP,
WebSocket and disposable PostgreSQL. It uses an isolated confirmed-email Auth
fixture, not a hosted signup service. Each case checks non-silent native Web
Audio output, durable pause, lobby save revision, return, exit/reopen and exact
checkpoint digest recovery after a dropped connection. Keyboard activation
of Sound does not inject START. Device-width checks cover every controller
button and prevent mobile auto-zoom from hiding overflow.

The older no-audio trade cores also retain disabled Sound controls through
their two-browser UI, scene reload and atomic save checks. The audio cores
now have a separate ordinary cross-version trade check: desktop FireRed and
mobile-emulated LeafGreen use actual Sound controls and native Web Audio,
pause and mute, reload a scene, and complete the atomic two-save commit.
One player deliberately waits while the other finishes; that completed scene
stops sound without changing either canonical save. Both contexts close after
the committed trade returns to the lobby. The fixtures use original C-created
cartridges; this does not prove earned-adventure provenance or sound fidelity.
The separate report is `build/trade-audio-validation.json`.

A separate earned-Pokémon journey now joins the retained input-driven PC
checkpoints to the actual browser lobby/trade flow and original Continue back
to the field. It exchanges distinguishable caught Rattata while retaining each
earned starter and recorded storage. Both unchanged GBA games accept the
resulting cartridges and match the party/storage bytes after Continue. The
consolidated proof is `build/earned-trade-validation.json`. This continuation
does not establish an entire fresh-account network replay or hosted Auth.

Battle audio and physical-device trade playback remain unqualified. These local checks do not establish
hosted email delivery, physical-device playback or 1,000-player capacity.
The combined evidence is `build/game-audio-validation.json`; the public
Netlify solo preview and its separate evidence are unchanged by this work.

## Current evidence

`scripts/inspect-audio-output.ts` ran the 7,571-frame new-game input movie in
each unchanged candidate and inspected its private output buffer after every
frame. Both produced 701 interleaved float samples per channel per frame after
initialization. Each had 7,392 non-silent frames; all inspected samples were
finite and within [-1, 1]. Another 120 frames reproduced identical PCM bytes
after complete checkpoint restoration, with canonical state parity.

The reports are `build/audio-output-{firered,leafgreen}.json`, with source and
artifact identities. These checks establish that the existing mixer runs and
restores deterministically. They do not establish audible browser playback or
fidelity against the original GBA sound.

The inspector derives the private buffer location from the exact local
`KantoOutput` layout. That is trusted qualification instrumentation. Browser
and server runtime code must use an explicit, bounded audio ABI instead of
depending on private offsets.

## Original inspection constraints and remaining qualification

1. Keep read-only, bounded sample/format exports in the separate experimental
   artifact lane. Retain the qualified 16 MiB candidates and their evidence;
   the new WASM bytes require new artifact identities and exact checkpoint
   baselines. Audio reads must leave canonical state unchanged.
2. Preserve every generated frame in order. `Platform_QueueAudio` itself
   replaces its output, and `kanto_step` can advance multiple frames. Reading
   only after a multi-frame step would drop the earlier audio. The worker must
   collect each frame, as the preview now does, or use a correctly bounded C output queue.
3. Resolve sample timing explicitly. The native mixer declares 42,060 Hz
   (`60 × 701`), while the original frame duration produces approximately
   41,868.978 sample frames per real second. Feeding the current output as an
   uninterrupted 42,060 Hz stream would consume it faster than it arrives.
   Preserve original simulation timing and qualify pitch/tempo and resampling
   against the independent original GBA reference.
4. Qualify hosted authenticated playback, further trade scenarios and battle audio.
   Mute, pause, background tabs, restart and checkpoint replacement must not
   leave stale queued sound or affect verified game state. Use the shared
   shadcn controls for all player UI.
5. Check both editions, multi-frame worker batches, audio/device sample-rate
   changes and restoration. Compare music and sound effects with original GBA
   captures, then check physical devices. Non-silent finite PCM alone does not
   qualify the audio feature.

Run finite inspections through the project resource guard. The inspector
refuses to replace retained reports. It does not modify the candidates, enable
capability flags. Deploying an experimental audio preview does not qualify
hosted accounts, the full adventure, physical devices or original sound fidelity.

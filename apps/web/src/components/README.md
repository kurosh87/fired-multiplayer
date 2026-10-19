# Kanto UI

Use the shadcn/ui components in `ui/` for buttons, forms, selectors, badges,
keycaps, panels, tooltips and dialogs. These are official New York registry
sources, with local TypeScript imports and the shared `cn` utility. Provenance,
source hashes and the upstream MIT license live alongside the components.

`src/theme.css` owns semantic colors, focus rings, surfaces and radii for the
light account/lobby screens and dark browser player. The player changes its
primary color with the selected edition. Layout CSS handles the canvas frame and
controller geometry; focus, disabled states and dialog behavior use shadcn/Radix.
Use Lucide for application icons. Keep new UI on these same primitives.

Use the official shadcn `Field`, `FieldLabel` and `FieldDescription` for form
rows. Associate each label with a unique input ID and connect helper text with
`aria-describedby`. Use `EmptyState`, composed from shadcn `Empty`, for profile,
lobby and search empty states. It provides the same icon tile, heading,
description and optional action across these screens; use its compact treatment
inside a card. Trainer actions use Lucide icons alongside visible labels.

Use `Button`'s `variant` and `size` props instead of creating another button
class: default for the main action, secondary or outline for alternatives,
ghost for navigation and quiet actions, and destructive for confirmation of
an irreversible action. Current navigation uses `aria-current="page"`.
Account dialogs restore focus to the opener when dismissed.

Use `Card` for adventure, party, invitation, directory and empty-state panels.
Use `LobbyPanel` for party, directory and invitation panels. It composes the
shadcn card header, description, action, content and footer with a Lucide icon,
a semantic heading and an optional status badge. Keep actions in its footer and
use the shared semantic surface tokens for trade offers.
Use `StatusMessage` (composed from the official shadcn `Alert`) for application
feedback: ordinary messages use a polite status region; errors use an alert
region. Keep labels associated with the shared `Input` and `NativeSelect`.
Do not add global button, input, select or focus styles that replace the
primitives' variants, disabled treatment or focus rings.

The warm account screens and dark player share semantic surface, text, border,
radius and focus tokens. FireRed and LeafGreen have explicit accent pairs in
`theme.css`. Edition artwork, the pixel canvas and controller geometry are
application layout; use CSS for those while keeping their controls on `Button`.
Mobile header and navigation actions have 44px minimum touch targets.
Show editions and save state to players. Keep save revisions in protocol state
and diagnostics; the adventure cards and lobby toolbar use simple labels.

The player toolbar provides game selection, pause/resume, restart, sound, stats,
fullscreen (where supported) and a keyboard guide. Opening the guide pauses the
game; closing it leaves the game paused until Resume. The performance overlay
reports canvas updates per second, their average interval and the simulation's
speed relative to the original frame duration. It does not report server capacity
or invented network latency. Background tabs pause automatically.

The experimental audio preview starts muted. Its shadcn Sound button enables
bounded stereo playback after a user gesture. Pause, mute, original reset and
restart flush queued sound. Imperative preview toolbar handlers use DOM event
listeners so Radix tooltip rerenders cannot replace their click bindings.

The authenticated Game screen uses the same dark semantic tokens, edition
accent, shadcn button variants and focus styles. Below 700px, its controller
uses two rows so all buttons fit the device width. Sound, pause, lobby entry
and exit use the shared primitives. A quick keyboard or touch press remains
latched until the next game tick, even when released between animation frames.
Released taps receive one game frame rather than a full catch-up batch. Pause,
guide entry, backgrounding, exit and disconnect clear pending input.
Its branded top bar adds Controls, Stats
and supported-browser fullscreen. The Stats overlay counts actual canvas
updates, their average interval, and simulated time relative to elapsed time;
it makes no network-latency or server-capacity claim. Opening Controls clears
held inputs and pauses audio and verified play. Closing it leaves play paused
until Resume. Fullscreen includes the document so Radix portals remain visible.
Local original-C/verifier/PostgreSQL checks
cover both editions on desktop and mobile, including checkpoint recovery and
sound cleanup. Hosted accounts, physical devices and battle sound remain
separate qualification work.

The opt-in Game UI qualification runs inside `scripts/check-database.py` with
`KANTO_CHECK_AUDIO_GAME_UI=1`. Set a fresh `KANTO_AUDIO_GAME_EVIDENCE_TAG` to
retain each run independently. It requires the existing audio-16 artifacts,
their retained PC route checkpoints, the local Vite server and Chrome. Run
finite work through the project guard. Player-tool evidence and exact source
snapshots are recorded separately in `build/player-chrome-validation.json`.

The public Netlify deployment remains a temporary solo preview. Account screens,
verified saves, battles and trades still require the separate backend.

Authenticated players answer the server's periodic `auth-required` message with
the current browser session token. Adventure/trade and battle screens share
`lib/socket-auth.ts`. Renewal keeps the existing socket, game state and input
sequence. It does not automatically resume a paused game or enable sound.
Failed credential retrieval closes the connection so normal verified recovery
can take over. The server rechecks the confirmed account and suspension status;
a different signed-in account cannot take over the existing game connection.

The solo preview shows a Session only badge beside the game with an explicit
reload/restart explanation. Restart opens a shadcn Dialog and pauses play.
Cancel or Escape preserves the existing worker and leaves it paused; confirm
starts a fresh preview of the selected edition. Focus returns to the restart
button on dismissal. Keep reset confirmation separate from the keyboard guide.
The preview does not claim cloud storage or use the account game's save labels.

The account player shows Online, Saved, Saving, Connecting or Play paused
beside a plain status message. Saved feedback follows the server's durable
acknowledgements; the pause confirmation follows its checkpoint acknowledgement.
Keep input frame numbers in diagnostics rather than live text for players.
Mobile controller buttons have at least 44px touch targets, with safe-area
spacing below the account controller.

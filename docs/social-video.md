# PowerBin social video

Target: 25–30 seconds, with captions and no required audio. Use real app captures
and cuts between states; do not imply that edited timings measure sync latency.

The initial [28-second MP4 draft](media/powerbin-social-draft.mp4) uses actual macOS,
iOS simulator, and browser captures, arranged as a captioned sequence of states. It has no
audio. The outline below can guide a subsequent continuous screen recording.

| Time | Capture | Caption |
| --- | --- | --- |
| 0–3s | Browser Send alongside the native Inbox | A little less copy/paste. |
| 3–9s | Send a short snippet to a named native device; show it arrive | One shared Rust app. Native Shell + PowerSync. |
| 9–14s | Copy & burn; the Inbox becomes empty | Copy it. Burn it from PowerBin. |
| 14–19s | The same saved snippet on both devices | Keep the things you want to keep. |
| 19–24s | Guest preview, explicit reveal, then a second opening showing the consumed link | Share once. No account required for the recipient. |
| 24–29s | Brief code view, then repository title | Local SQL. Watched queries. Your backend. |

The code shot should show `insert`, the upload transaction, and the watched
query in `app/src/db_native.rs`, or the equivalent browser adapter. Keep text
large enough to read on a phone. Use a published repository URL only after the
user has pushed it; no placeholder deployment or template link.

Use synthetic text. Exclude setup tokens, device tokens, private keys, browser
storage, and full environment files from all captures. Pairing fingerprints and
guest secrets are not needed in the final edit. Describe burning as removal
from PowerBin after sync; an offline burn queues the server change. Keep the fuller
privacy boundaries in the accompanying blog post.

The README's verification table is the source for platform claims. A compiled
mobile target alone is not footage of a working mobile app.

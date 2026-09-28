# Session surface

Mode: Operate. Code-led implementation of a small call companion.

## Direction contract

THESIS: The operator can read the latest spoken turn and a directly speakable reply at one glance.

OWN-WORLD: A quiet graphite broadcast desk, warm white type, pale mint for active capture and primary action, thin separators. Mono belongs only to time and transcript measurements.

STORY: Configure instructions, choose inputs, start listening, trigger a reply or let the configured model intervene, export.

FIRST VIEWPORT: Compact identity and recording bar above two columns. Transcript occupies the left; a larger answer and keyboard action occupy the right. Settings are a separate view. One visible transition is a streaming reply becoming complete.

FORM: Third grounded direction, broadcast prompter, seed f313c8b1. Other candidates: notebook, support console, interview cue sheet, newsroom rundown, audio recorder, messaging split view. Clear states and wide readable fields borrow discipline from the dealt jackfield and cloud systems.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Implemented surface

The shared visual system is documented in [DESIGN.md](../DESIGN.md). The local Impeccable panel sidecar is `.impeccable/design.json`; its directory is ignored by Git. This brief remains the durable source for session-specific composition and workflow.

- At desktop widths, the workspace uses two columns (`1.02fr` transcript and `1fr` answer; `1fr` and `1.05fr` from 1500px). It has a 570px minimum height, viewport-related height, and 1050px maximum height.
- At 760px and below, the panes stack. The transcript scrolls in a bounded 330px region; answer content has a 500px maximum scrolling region. Controls follow their respective content areas.
- Settings are a separate view. An active session stays visible there through a status label, elapsed timer, and stop action. Locked audio configuration names the reason and recovery beside its fields.
- The signature state change is a reply streaming into the prominent answer region, then becoming a completed, copyable suggestion. The cursor is removed on completion. Reduced-motion settings remove animation and transitions.

## Finish evidence

The independent finish review examined desktop (1440px), compact (390px), and settings screenshots of the labeled synthetic demo. Its one material finding, lost capture visibility in settings, was corrected and scored resolved on the regenerated captures. The final disposition was **ship**, scoped to that correction and the supplied static views. This is not validation of real audio capture, global keyboard behavior, API performance, or streaming motion.

The review captures live in `.impeccable/review/`. The repository screenshot and application icon have provenance in [the asset register](assets/README.md). Font and interface-icon notices are bundled under `public/licenses/`.

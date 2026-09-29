# Local microphone test surface

**Route:** `/local-test` · **Mode:** Operate

The operator selects a language and microphone, starts a solo test, reads evolving text, then stops to inspect timing and download a report. Setup and measurement definitions are in [the run guide](local-transcription-test.md).

## Layout

The surface preserves Callside's graphite panels, mint main action, DM Sans typography, outline icons, thin dividers, and rounded controls. A centered container has a maximum width of 1180px and 32px side padding. Language, microphone, and the main action sit above a status row with input level and elapsed time.

The workspace pairs a scrolling transcript with a 290px timing pane. The transcript is 395px high. At 760px and below, timing stacks beneath the transcript, measurements form two columns, the main action fills its row, side padding becomes 20px, and transcript height becomes 320px.

## States and actions

- Engine check and unavailable states disable Start. An unavailable engine shows launch instructions.
- Ready names the microphone as off. **Start microphone** begins capture; **Connecting…** indicates startup. Language and microphone choices lock during startup, listening, and completion.
- Listening shows capture status and **Stop**. Transcript entries label **Me**, distinguish muted **Live draft** from **Final** text, and show measured delay when available.
- Stop shows **Finishing…** while the last phrase completes, then confirms the microphone is off. **Start a new test** clears previous results.
- **Download test report** becomes available after capture stops and measurements exist. Errors and timing-history failures appear as alerts.

## Review scope

Disposition: **ship**, scoped to the supplied static views and the capture-state fix. Independent review confirmed the device-label refresh is best effort: an `enumerateDevices` rejection after microphone acquisition keeps listening and Stop available. Startup errors cancel an acquired capture handle. The targeted Playwright regression passed live and ended track checks.

Review images cover desktop, mobile, idle, enumeration failure while listening, and stopped states. They are retained locally under `.impeccable/review/local-test/` and excluded from Git.

No physical microphone was used in verification. The surface is ready for the user's live run.

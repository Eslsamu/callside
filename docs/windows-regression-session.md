# Windows regression session

One fixed-price $10 tester task, subject to agreement before hiring. Use the updated preview link supplied for this session; the October 7 installer does not contain the fixes. This is one session and report, not unlimited debugging or a guarantee that Windows support passes.

## Before hiring

Confirm availability, the scope and budget, and either an existing eligible ChatGPT subscription the tester is comfortable connecting or a supplied API test key. No subscription or API-credit purchase is required. Agree on a test-call partner or a second device/account that provides both sides of a call. A replay alone does not verify meeting-app routing.

The maintainer first runs the Windows preflight workflow: unit tests, unpacked app build, desktop persistence checks and real packaged Whisper inference. Review timing as well as success. These checks do not validate physical audio or live account authorization.

## Session

Use non-private English test speech and keep Windows security software enabled. Prefer headphones for the baseline; note output device and meeting app. Never put account details or credentials in screenshots or reports.

1. **Install and identify the build.** Record the new build ID and any warnings. Check microphone permission for desktop apps, refresh the app's input list and explicitly select the working input. Test another available input if necessary; record what changed.
2. **Retest capture and overload.** Run microphone and system-audio checks separately, then the supplied combined conversation. Check meaning, omitted questions, duplicated words and speaker consistency. Compare combined capture with speaker labeling off and on where available; record configuration. Stop once while work is pending and verify queued text or a useful error appears.
3. **Test an answer.** Use the agreed connection: sign in to ChatGPT yourself, or select Provided API test key and enter the supplied session-only key. Request a suggestion using harmless test text. API mode does not verify ChatGPT subscription sign-in; mark that part untested. If blocked, record the exact sanitized error and stage. Do not repeatedly reconnect or buy anything to overcome a blocker.
4. **Complete one 20–30-minute call if the basics work.** Exercise both microphone and meeting audio, taking turns and including some longer speech. Choose the 30-minute call limit in the guided test. Note whether delay grows over time and whether speech is missing, repeated or attributed incorrectly. After stopping capture, request suggestions from the captured call and check both F8 and Ctrl+Shift+Space with the meeting app focused. The guided test serializes capture and answer checks; it does not validate suggestions during active capture. If sustained capture fails, document the failure and move to the remaining checks rather than repeating the full call.
5. **Restart.** Save progress and use the restart check. Verify retained settings and account connection, then export the JSON report. The exporter retains recent transcript entries and inference measurements, not an exhaustive 30-minute trace; include start/end observations in the summary.

## Deliverables

- Built-in JSON report through Upwork.
- Short summary: build ID, meeting app/audio setup, checks passed/failed/blocked, actual call duration, meaningful transcript mistakes and approximate delay at the start/end. Note any steps not covered by the guided exporter separately.
- One GitHub issue per distinct new problem, with reproduction steps and expected/actual results. Add new evidence to an existing issue when it is the same problem; do not duplicate issue #32 unnecessarily.

A clear blocker report plus the remaining feasible checks satisfies completion. Fixing bugs is not part of this task. A passing result on one PC does not resolve another PC's device-specific failure.

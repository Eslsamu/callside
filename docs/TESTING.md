# Testing

Key-storage tests save authenticated synthetic ciphertext in temporary directories, restart the local server, and verify restoration, deletion, file permissions, unavailable/insecure storage rejection, and error redaction. They never access a real OS keychain or call OpenAI. Browser tests exercise the remember/remove controls with mocked storage capabilities. Transcript reconciliation tests cover cross-channel arrival order, small ASR differences, numbers/negations, short answers, later repetitions, and blank turns. Real microphone echo varies with routing and hardware, so use headphones for the final live check.

## Automated checks

```sh
npm ci
npx playwright install chromium
npm run check
```

The build performs TypeScript checking for the UI and server. Unit/integration tests exercise application behavior without a paid provider connection. Playwright runs a headless Chromium instance against a separate local development server using an empty provider key.

The suite contains **43 unit/integration tests** and **6 browser tests**. These counts describe the checks in this repository; hardware and real provider acceptance are separate below.

Browser checks use the explicit demo fixture to cover transcript rendering, manually requested suggestions, keyboard triggering, automatic hints, configuration, GPT-6 model/reasoning/Fast settings, and exports. Demo tests guard against accidental use of real capture devices. The CI workflow does not receive an OpenAI key.

A separate browser check generates synthetic audio with an oscillator and supplies its `MediaStream` to the actual capture code. It exercises AudioWorklet processing, PCM packets, turn commits, transcript events, and track cleanup. Its WebSocket peer is intercepted, so no audio leaves the test server/browser environment.

Fixtures make app behavior repeatable. They do not verify actual OpenAI access, microphone quality, acoustic diarization accuracy, OS audio sharing, or live latency. Successful automated checks must not be described as a successful real call.

## Desktop smoke check

```sh
npm run test:desktop
```

This separate check builds the production application and starts a hidden Electron window with an isolated temporary profile. It verifies the production shell, preload bridge, IPC, demo transcript, answer event, and always-on-top control. It does not use real audio, call OpenAI, or register actual global keyboard shortcuts. The test sends the same IPC event that the native shortcut handler would send, then closes the app and removes its temporary profile.

Passing this check confirms the desktop integration under the tested environment. Actual OS shortcut registration, microphone permissions, and system audio routing still require the real-audio acceptance checks below.

## Real-audio acceptance checklist

Run these checks with your own API project, a short synthetic conversation, and the participants' agreement. API charges apply. Complete OS permission prompts yourself.

1. Start a real session with microphone only. Speak two short sentences separated by silence. Confirm partial text becomes final and the correct source label appears.
2. Enable shared audio and select a browser tab playing agreed test speech. Confirm system text appears independently and no video is sent to OpenAI.
3. Use headphones. Alternate local and remote speech and confirm their labels are not duplicated by acoustic echo.
4. Press F8 in the focused app, click the response button, and submit a typed question. Confirm the answer uses recent context and streams progressively.
5. Enable automatic mode with a narrow rule. Ask a matching question, then make a nonmatching statement. Confirm the first can produce a suggestion and the second can remain silent. This is a model-behavior check, so record the observed behavior rather than requiring a deterministic answer.
6. Use diarization with two voices on the same source. Confirm within-block speaker labels and accurate timing. Confirm labels remain visibly scoped to each block.
7. Stop mid-sentence. Confirm the capture indicators stop, OS device access ends, and the final buffered speech either completes or an actionable error is reported.
8. End screen sharing from the OS/browser control. Confirm Callside handles the ended source visibly and does not claim uninterrupted recording.
9. Briefly disconnect the network. Confirm the error is visible and no endless request or recording state remains after Stop.
10. Export JSON and Markdown. Confirm the intended transcript and suggestions are present without an API key.
11. In desktop mode, switch to another application and use the global shortcut. Confirm a suggestion appears in Callside without speaking into the call.
12. Quit the desktop app. Confirm the local server exits and microphone/system capture indicators clear.

## Release checks

- Run automated checks from a clean `npm ci` installation.
- Build and smoke-test the desktop package on each supported target OS.
- Repeat the short real-audio checks on each advertised OS/capture path.
- Configure signing/notarization before publishing signed installers.
- Review the Git tree and release contents for secrets, recordings, exports, and test artifacts.
- Record any untested OS, hardware, or model combinations in the release notes.

The initial repository does not claim real-audio or cross-platform hardware certification. These acceptance checks remain a maintainer/operator step on the actual devices used for calls.

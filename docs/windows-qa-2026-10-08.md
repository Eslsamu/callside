# Windows preview QA findings — 2026-10-08

Source: three tester JSON exports from October 7, follow-up clarifications, and [issue #32](https://github.com/Eslsamu/callside/issues/32). All reports identify preview 0.7.0, Electron 44.4.5, build `2026-10-07T08-00-58-639Z`; source commit `bbb133034102ee63f44135cbd40382a376bf37f4`.

## What the tests establish

| Check                           | Laptop: i7-6500U, 4 threads, 12 GB                   | Desktop: i5-6500, 4 threads, 16 GB                                           |
| ------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| Installer and launch            | Tester confirmed success with Defender enabled       | Same                                                                         |
| Microphone                      | Signal detected, peak 1.0; no transcript in 32.3 s   | Input unavailable before capture; zero signal                                |
| System audio                    | Signal detected, peak 0.741; no transcript in 35.3 s | Correct transcript confirmed; first text 25.219 s after first detected sound |
| Combined sources                | Stopped due to transcription backlog after 38.489 s  | Blocked by microphone acquisition                                            |
| Speaker labeling                | Three speaker IDs, six attribution events            | Not validated                                                                |
| Real call                       | Backlog stop after 21.558 s                          | Blocked by microphone acquisition                                            |
| F8 and Ctrl+Shift+Space         | Confirmed outside app in follow-up                   | Same                                                                         |
| Restart/settings/secure storage | Passed                                               | Passed                                                                       |
| ChatGPT answer                  | Not run in export; sign-in error reported later      | Skipped in export; same sign-in error reported later                         |

The desktop system-audio test took 73.119 s in total. First-text time includes the spoken phrase and processing; it is not a clean post-speech latency measurement. Speaker event counts do not establish correct attribution. Neither report validates a complete working call. Portable ZIP installation was not tested.

## Additional modern-hardware report

A third report from an i7-13700H (20 logical threads, 32 GB RAM, Windows build 26200) received microphone and system audio and produced transcripts, but reproduced backlog failures in combined capture (44.117 s) and a real-call check (46.492 s). Microphone first text arrived at 17.090 s; system first text at 25.503 s. The system transcript changed “is in pounds” to “isn't pounds” and omitted the final question. The tester marked microphone accuracy unsuccessful and noted uncertainty about their German pronunciation.

Shortcuts and restart persistence passed. ChatGPT inference was not run; the notes contain the same authorization-renewal error. These findings show that overload is not confined to old CPUs. This report was reviewed after the initial fixes; it does not validate them. Only one of the three machines reported unavailable microphone input.

## Findings and changes

### Missing transcripts and hidden errors

Confirmed code bug: `startCapture` discarded errors after stop began, although local inference continues while draining. An inference failure during that interval could produce “No transcript received” with an empty error list. Errors now reach the caller during drain, and the guided test records a failure even if the tester manually stopped capture. Native inference timeouts now produce a specific message instead of the generic local failure.

The old reports cannot establish whether the laptop returned empty text or hit an inference timeout. Its nonzero signal proves capture received samples, not that they contained clean speech. New reports include per-source local inference duration, request/queue time, audio duration, and empty-result flags, with no raw audio or device identifiers.

### Local processing load

Previously, each input repeatedly decoded growing draft phrases and then decoded final phrases again; both inputs share a serialized inference engine. This adds substantial avoidable work on slow CPUs. Windows live capture now requests final phrases only (after a pause or at the existing 12-second phrase boundary). Other local pipelines stop requesting drafts after observing slower-than-audio decoding.

The old four-phrase queue limit could stop after only a few short utterances and cancel all queued speech. The limit now uses 60 seconds of queued final audio. At that limit capture stops explicitly and queued speech drains. Processing errors can still prevent completion; the app reports them. There is no automatic cloud fallback.

This reduces wasted work, but does not demonstrate that large-v3-turbo is fast enough on the tested CPUs. Short completed phrases may still take too long. Choosing or bundling a smaller model remains a separate possible follow-up after measuring this revision.

### Microphone selection

The guided test used `DEFAULT_SETTINGS`, always selecting the OS default input. Changing the microphone in the main app did not affect it. The test now has its own device list and selector, applied to all microphone checks in that session, plus Windows desktop-app permission guidance. Device IDs are not exported or persisted in the QA checkpoint.

The desktop headset working in another app does not identify the Callside failure: a different OS default, permission, disconnected endpoint, or driver issue remains possible. Explicit input selection enables the next test to distinguish these cases. No silent fallback to another microphone is used.

### ChatGPT connection

The old token-exchange error said “could not be renewed” for both initial sign-in and refresh. It discarded HTTP status and the error code, and asynchronous callback failures were not necessarily recorded in the QA report. The new handling distinguishes the stage, temporary failures, invalid client registration, and unusable refresh tokens. It exposes HTTP status and recognized error codes without raw OAuth responses. Temporary failures preserve credentials; confirmed unusable refresh tokens are removed while registration is retained for reconnection, following [OpenAI's recovery guidance](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery).

The exact cause of the tester's sign-in failure remains unknown. No live account sign-in or paid inference was performed during these fixes.

## Focused Windows retest

### Before commissioning another session

The first automated tests used mocked inference. The follow-up audit adds `node --import tsx scripts/check-local-inference.ts`: actual CPU-only inference through the production local HTTP route, with cold, warm, and concurrent requests. On Windows it requires the executable and model from the unpacked preview; it does not substitute a globally installed runtime. The Windows build workflow now runs unit tests and this check, retaining `.local/windows-qa/native-inference.json` even on failure. The standalone Windows preflight workflow has now executed it without creating an installer. [Run 37771333418](https://github.com/Eslsamu/callside/actions/runs/37771333418), commit `82b32b8`, passed all 137 unit tests, the unpacked app build and the native desktop persistence/restart smoke test. The real inference check failed: the 5.32-second English fixture hit the production 30-second timeout (HTTP 502, 30.095 s elapsed) on the Windows runner (four allocated CPU threads, AMD EPYC 7763, 16 GB RAM). Model loading took 509 ms. No transcript was returned; warm/concurrent checks were not reached. The exported evidence is retained in that run's `Windows-native-inference` artifact.

This is a virtual runner, not a prediction of a particular laptop's speed, but it demonstrates that the packaged runtime can launch while inference still fails under the production timeout. Do not commission the paid retest yet. Investigate CPU inference throughput/configuration or provide and validate a suitable lightweight local option first. Merely extending the timeout would not establish usable live latency. Linux build/unit/browser CI also passed at the same commit.

The first Windows run exposed a POSIX-only file-permission assertion; that assertion now applies only on POSIX hosts, while ciphertext and persistence checks continue on Windows.

Local CPU-only results on an M1 Pro, 10 logical cores/16 GB, native Whisper using four threads, for the same 5.32-second English fixture:

| Model                    | Cold request | Warm request | Second concurrent request | Qualitative observation                                  |
| ------------------------ | ------------ | ------------ | ------------------------- | -------------------------------------------------------- |
| large-v3-turbo Q5        | 10.29 s      | 9.48 s       | 19.01 s                   | Replaced “pounds” with “parents”; retained the question  |
| small Q5_1, multilingual | 2.38 s       | 2.32 s       | 4.74 s                    | Preserved “pounds” and the question; omitted punctuation |

These are macOS CPU-only measurements, not predictions for the tester's older Intel CPUs. The initial large-model check flagged the currency error. The executable check now asserts the main clause and final question while recording the exact transcript and currency recognition separately, so a known model error is not mislabeled as a broken executable. Passing this check means inference functions, not that quality or latency is acceptable.

A second, synthetic 7.08-second German workshop sentence took 10.12 s with large-v3-turbo and 2.46 s with small. Both returned the same correct wording, normalizing “sieben” to “7”. This supports further evaluation of the smaller model; two short recordings do not establish broader recognition quality.

The small-model download was pinned to revision `5359861c739e955e79d9a303bcbc70fb988958b1`, 190,085,487 bytes, SHA-256 `ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb`. It is currently a development comparison only, not an installer option or a changed app default.

Do not commission a repeat of the old test yet. First execute the real packaged-inference check on Windows and include one clear report-driven checklist for remaining device/authentication cases. The 137 unit tests, all five mocked Windows browser flows, and isolated Electron persistence/restart smoke test passed locally, but none establishes physical Windows capture or live OAuth eligibility.

Use a newly prepared development preview when requested; the existing downloaded installer does not contain these changes.

1. On the desktop, refresh inputs, choose the working headset explicitly, and run the microphone check. If unavailable, record Windows default input and whether desktop microphone access is enabled; keep security software enabled.
2. On the laptop, run microphone and system checks separately, then the combined fixture. Review final text, delay, and exported inference timing/empty results. Start combined checks with speaker labeling off, then repeat with it on to isolate its overhead.
3. Stop during processing and confirm any failure is retained in the report. Captured final phrases should continue appearing while the queue drains.
4. Retry ChatGPT sign-in and report the exact new sanitized error if it fails. If connected, test one suggestion and reconnect after restarting. No subscription purchase is required.
5. With capture functioning, complete the real-call and speaker-correctness checks previously blocked. Do not count event totals as an accuracy pass.

Windows support remains experimental until these hardware checks pass. Automated tests cover the failure handling and mocked capture flow, not Windows drivers, CPU throughput, or live OAuth eligibility.

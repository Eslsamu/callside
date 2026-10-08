# Windows guided hardware test

See [the October 8 QA findings and focused retest](windows-qa-2026-10-08.md) for the three-machine results, fixes in the current source, and remaining blockers. Older preview artifacts do not contain those fixes.

## Download an auditable GitHub Actions test build

Open the **Windows test build** workflow under the repository's Actions tab. Select a successful run and download its `Callside-Windows-Test-x64-<commit>` artifact (GitHub sign-in is required). Extract the artifact ZIP and read `START_HERE.txt`. Run the included `.exe` installer, or extract the nested portable `.zip` completely and run `Callside.exe`.

The artifact includes `BUILD.json` with the exact source commit and workflow run, plus `SHA256SUMS.txt`. It is built on a GitHub-hosted Windows runner from the public source, not uploaded from a maintainer's computer. It remains unsigned: provenance does not guarantee safety or remove Windows security warnings. If blocked, report the warning without disabling security software. Artifacts expire after 30 days; no release or version bump is created.

Developers can reproduce the preview on Windows with Git, Node.js 22.12 or newer, CMake and Visual Studio C++ build tools: run `npm ci`, then `node --import tsx --input-type=module -e "import { ensureWhisperModel } from './server/whisper-model.ts'; await ensureWhisperModel();"`, then `npm run desktop:windows-preview -- --test-package`. The workflow shows the same build commands. The model download is checksum-verified.

This development preview targets Windows 11 on Intel/AMD x64 PCs with AVX2, FMA and F16C. It is not a version release or a claim of general Windows support. Windows on ARM and older CPUs are outside this preview.

## One tester session

Run `Callside-Windows-Test-x64.exe`. The installer works per user, creates a shortcut, and opens the guided test. No developer tools, API key or separate model download is needed. A current eligible ChatGPT subscription is needed only for the answer test. Allow approximately 10–15 minutes after initial model loading; a short call with a second person can be included in the same session.

1. Prepare the bundled Whisper model and enable test capture. Refresh the microphone list and select your headset or built-in input if the Windows default does not work.
2. Read the English microphone sentence; play the computer-audio sentence. Review each transcript for substantial errors.
3. Play the four-speaker meeting excerpt while both sources are captured. Remain silent during playback, then read the microphone reply. Review text, source separation/echo and speaker consistency.
4. Make a test call in the usual call app. Choose the 90-second quick check or 30-minute sustained-capture limit. Take turns saying non-private test sentences. This step checks real call-device routing; it can be skipped if no partner is available.
5. Check F8 or Ctrl+Shift+Space with another window active. Sign in to the tester's own ChatGPT account, choose an available model and request one suggestion using the button or armed global shortcut. Review usefulness and speed.
6. Save progress and restart. The app checks retained settings, encrypted storage and, if previously connected, the ChatGPT connection. Previous template settings are restored.
7. Save the JSON report and return it manually. A failed or skipped check never counts as a pass and does not prevent other checks.

Results are saved locally between steps. An interrupted recording is marked interrupted on reopening, not resumed automatically. A failed speaker setup can be bypassed explicitly to finish the audio checks, while speaker labeling remains unverified. No automatic cloud fallback is used.

The preview uses separate `Callside Windows Test` application data and does not check for updates. Installing or removing it does not replace the normal Callside app. Removing the test app preserves its settings and test progress.

## Included runtimes and fixtures

- Whisper large-v3-turbo-q5_0, with a checksum-verified 574 MB model. The Windows executable uses CPU inference, is statically linked, and does not require the tester to install Visual C++ runtime libraries. It runs without a console window.
- Experimental LS-EEND AMI speaker labeling in an isolated worker using single-threaded ONNX Runtime WASM. The pinned model is included. No Python, GPU, model account, or paid service is required. Four anonymous remote voices are supported. Labels are estimates; overlapping turns may remain ambiguous. Microphone identity comes from the input source rather than voice recognition.
- The individual system test is a short English sentence about euros and pounds. The combined test uses 50 seconds of the AMI Meeting Corpus, ES2004a, under CC BY 4.0. Its exact attribution, reference cues and known limits are in `public/windows-speakers-test.json` and `public/windows-speakers-test-LICENSE.txt`.

The excerpt was selected as a known functional check, not an unbiased model benchmark. Direct local inference recognizes four identities, but this does not guarantee perfect word attribution in a live call.

Windows live transcription processes completed phrases to avoid repeatedly decoding drafts on the CPU. Text appears after a pause or at the 12-second phrase boundary, plus inference time. Older CPUs may still be too slow for this model. The report records inference and queue timing; test speaker labeling off and on separately when diagnosing processing load.

## Report and privacy

The report contains test transcript text, optional notes, check outcomes, approximate timing, app/build versions, CPU/RAM and shortcut/secure-storage capability results. It excludes audio, credentials, account identifiers, device IDs, usernames, saved templates and local paths. Nothing is uploaded automatically. The answer test sends the displayed test transcript to the tester's ChatGPT account, counts toward plan limits, and never switches to API billing.

A disposable encrypted sentinel checks storage across processes. It is separate from real credentials. The settings test temporarily saves a nonce through the normal template store, keeps a local backup, and restores the previous template afterward. That backup is not exported.

Unsigned private previews can trigger Windows security warnings. If the installer or app is blocked, return a screenshot; do not disable security software. Actual Windows audio devices, call applications, account login, installation and security behavior require the tester's machine. Browser mocks, native binary import inspection and macOS Electron checks cannot establish those results.

## Rebuild and developer verification

The current Mac build machine needs Xcode tools, CMake, MinGW-w64, Node and Git. These are developer-only dependencies. A native Windows build can use CMake/MSVC with static linking.

The pinned Whisper model must exist at `.local/models/ggml-large-v3-turbo-q5_0.bin`. The build downloads/verifies the small portable speaker model using a pinned revision and hashes. A personal instruction file at `.local/windows-test-instructions.txt` is included; otherwise the English instructions are copied.

```sh
npm run build
npm test
npx playwright test -g Windows
node tests/windows-desktop-smoke.mjs
node scripts/windows-speakers-setup.mjs
node scripts/check-portable-speakers.mjs
npm run desktop:windows-preview -- --test-package
```

The explicitly requested test build produces a private NSIS installer and portable ZIP under `.local/windows-preview`. It does not bump the version, publish, create a DMG, or change `release/Latest`. A timestamped build ID distinguishes reports.

Verification covers mocked account success/failure without provider charges, actual browser audio processing, capture cleanup, report redaction, native Electron checkpoint/restart/export with isolated profiles, actual portable speaker inference and packaged ASAR/WASM loading. The hidden native test substitutes encryption to avoid host credential prompts; Windows DPAPI is verified by the tester's actual restart step.

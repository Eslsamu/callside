# Changelog

## Unreleased

- Fix Windows upgrades reusing a cached large Whisper model instead of the bundled small model. Verify the production model-preparation path with an old cache present and show the loaded model in setup diagnostics.
- Archive prior-build Windows QA results separately, show the transcript used for the answer test, preserve recent answer errors across retries, and distinguish safe network error codes from upstream service errors.

- Use multilingual Whisper Small Q5_1 in the Windows CPU test preview, with a pinned checksum and real inference build check. Add explicit session-only API-key answer testing with provider-labeled reports, without changing the regular macOS model.

- Windows guided QA now uses English test speech, offers a 30-minute sustained-call check, and uses the captured call for follow-up answer checks.

- Add a real CPU-only Whisper fixture check to the Windows build workflow, exercising the packaged executable and serialized simultaneous requests, with retained timing and qualitative transcript evidence.

- Address Windows QA findings: select a microphone directly in the guided test, keep transcription errors visible during stop, reduce repeated local decoding on Windows, and drain captured speech on overload. Include local inference timing and empty results in test reports.
- Distinguish ChatGPT initial sign-in, temporary connection failures, and revoked refresh tokens; retain registration for reconnection and record asynchronous sign-in failures in Windows QA reports.

- Add a Language buddy template for selective wording help and corrections while learning a language in conversation. Existing libraries receive it once without replacing saved templates or the active setup. Document practical use cases and language-practice setup in the README.

- Add a GitHub Actions Windows test build with bundled local models, guided test instructions, checksums and source-commit provenance. This produces a development artifact, not a release.

- Add named templates with independent reference material and settings, copy/rename/delete controls, and migration of the previous saved setup.
- Split Settings into Templates & task, Models, Audio, Connections, and App. Show Save template only in Templates & task and space ChatGPT account actions consistently.
- Render Markdown in current and previous results. Fit the full current answer to the panel, resize it with the window, and offer a maximize/restore button with a single reading column. Escape restores the transcript layout.
- Remove hidden writing and manual-mode instructions. Send the editable task prompt verbatim and show the complete automatic-mode addition in Settings. Refine the visible Interview preset for spoken replies.
- Enable Fast mode for ChatGPT subscription suggestions and explain increased plan usage. Add diagnostics for models absent from OpenAI's catalog, hidden models, and unsupported model IDs.
- Detect saved Whisper models and distinguish loading from downloading after a restart or update.
- Explain macOS capture failures using current permission diagnostics and distinguish terminal-launched development builds from installed apps.
- Consume focused desktop answer-shortcut key events, including repeats, to address unhandled function-key alert sounds.

## 0.7.0 - 2026-10-04

- Provide an Apple Silicon community DMG with ad-hoc signing, no Apple notarization, and a documented first-launch approval flow.
- Keep community builds on manual downloads instead of the signed automatic-update channel.

- Update the vulnerable development dependency http-cache-semantics and isolate cloud audio test fixtures from local defaults.

- Prepare the public source repository with current local/cloud documentation, third-party notices, and contributor/security guidance.

- Add a private Windows x64 test installer with bundled Whisper and portable CPU speaker labeling, a guided simultaneous-audio and ChatGPT test, checkpoint recovery, restart verification, and a privacy-limited diagnostic report.
- Verify portable LS-EEND with a licensed four-speaker fixture and preserve local-only audio processing without extra runtime setup.

- Separate unpacked development previews from explicitly versioned installer releases.

## 0.6.0 - 2026-10-03

- Add an Apple Silicon DMG with drag-to-Applications installation.
- Bundle pinned Whisper and LS-EEND runtimes so installed users need no developer tools.
- Add model preparation with download progress and verified Whisper downloads.
- Add update checks, downloads, and explicit restart controls blocked during active work.
- Add public-release checks for Developer ID signing and notarization configuration.
- Public notarization and live update-feed validation remain pending; the repository is private.

## 0.5.0 - 2026-10-02

- Default call transcription to local Whisper, with OpenAI available independently.
- Add experimental local LS-EEND speaker labeling on Apple Silicon, alongside Off and OpenAI options.
- Add a local-audio plus ChatGPT-subscription preset with no metered API calls or automatic cloud fallback.
- Apply local speaker labels in the background without delaying suggestions or replacing transcript text.
- Bundle the native speaker runtime in the macOS desktop build and document source setup.
- Add OpenAI and ElevenLabs transcription comparisons and multi-speaker diarization benchmark results.

- Add a local Cohere-versus-Whisper comparison page with record-once replay, transcript comparison, latency, optional word-error scoring, cancellation, and report downloads.
- Add pinned Apple Silicon MLX setup and model provenance, plus synthetic English/German smoke measurements.

## 0.4.0 - 2026-10-02

- Add desktop ChatGPT sign-in for manual and automatic contextual suggestions using plan usage instead of API credit.
- Encrypt account credentials, refresh sessions automatically, and support account selection and sign-out.
- Load eligible GPT-6 models for the selected account and show the suggestion billing source.
- Keep transcription and speaker attribution on the separate API connection, with no automatic paid fallback for suggestions.
- Disable unsupported Fast mode and custom output caps in subscription mode.

## 0.3.3 - 2026-10-02

- Remove promotional interface copy and use functional headings, recording states, and empty-state instructions.
- Keep task configuration, privacy information, and keyboard guidance visible.

## 0.3.2 - 2026-10-01

- Keep course reference material out of the transcription prompt to prevent independent transcription length limits from blocking capture.
- Explain transcription length, key, credit, model, and rate-limit errors separately.
- Persist desktop templates independently of the local server port so they survive restarts and release updates.
- Show template save/reset feedback beside the buttons and retain edits if saving fails.
- Put desktop builds in numbered folders, such as `release/v0.3.2`.
- Update the `release/Latest` shortcut after successful packaging.
- Include the version, OS, and architecture in installer and archive filenames.

## 0.3.1 - 2026-10-01

- Make **Help now** / F8 infer useful help from the current conversation without a typed command.
- Give the Workshop preset short, ready-to-say suggestions and contextual automatic hints.
- Collapse the optional command field and migrate unchanged older preset instructions.

## 0.3.0 - 2026-10-01

- Add configurable tasks, reference material, and a Workshop preset.
- Allow automatic hints to follow either speaker's finalized turns.
- Add explicit prompt caching and request usage reporting.
- Make a custom output token limit optional.

Earlier development builds used descriptive folder names, and some shared a version number. Numbered packaging starts with 0.3.2.

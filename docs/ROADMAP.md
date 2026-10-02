# Roadmap

These are areas for discussion and contribution, not delivery commitments. Propose substantial changes in an issue before implementation.

## Current foundation

- OpenAI live transcription with microphone and call-audio channels.
- Contextual tasks triggered by a global shortcut or automatic rules, without typing.
- Reference material, editable prompts, model controls, and saved templates.
- Background speaker attribution and session exports.
- A local desktop/browser interface and synthetic tests without paid API access.

## Priorities

1. **Capture reliability:** reproducible macOS checks, Windows/Linux device testing, and clearer audio-routing guidance.
2. **Useful timing:** measure speech-to-text and first-result latency with representative audio and tasks; document tradeoffs instead of promising universal timings.
3. **Speaker attribution:** improve handling of microphone bleed, overlapping speech, and more remote speakers without delaying the live transcript.
4. **Provider adapters:** extend transcription and task-generation providers while preserving the existing application boundary.
5. **Distribution:** reproducible versioned builds and a maintainer-managed signing/notarization process before distributing signed installers.
6. **Context workflows:** discuss local file import and search separately from the existing pasted reference material; keep cost and data handling explicit.

Screen-capture exclusion needs platform-specific investigation and testing. Universal invisibility is not a supported capability.

## Useful first contributions

- Reproduce and document audio setup on your OS using synthetic speech.
- Improve setup instructions or error recovery without adding promotional interface copy.
- Add a regression test for an independently reported bug.
- Review accessibility with the keyboard and screen readers.

See [Contributing](../CONTRIBUTING.md) for local setup and verification.

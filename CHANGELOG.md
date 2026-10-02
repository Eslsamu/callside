# Changelog

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

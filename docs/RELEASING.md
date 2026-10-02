# Releasing Callside

## While the repository is private

Keep GitHub visibility private until the owner explicitly decides to publish. README positioning and topics prepare discovery for that future release; private repositories are not publicly indexed. The MIT license does not change repository visibility.

## Versioned releases

1. Verify the working tree contains only intended code, documentation, and synthetic fixtures. Exclude API keys, saved templates, real transcripts, local profiles, and recordings from both the tree and Git history.
2. Run `npm ci`, install Playwright Chromium, then run `npm run check`. Run `npm run test:desktop` on the target desktop OS.
3. Update the version with `npm version patch --no-git-tag-version` (or `minor` for a feature release), and describe changes and limitations in `CHANGELOG.md`.
4. Commit the reviewed changes. Build with `npm run desktop:pack` or `npm run desktop:dist` on the target OS. Outputs go into `release/v<version>`; `release/Latest` follows successful packaging.
5. Test the actual packaged application with synthetic data. Repeat real-audio checks where a release claims support. Local macOS development builds may use `CSC_IDENTITY_AUTO_DISCOVERY=false`; this does not create a signed distribution.
6. Tag the verified commit as `v<version>` and create a GitHub release with matching notes. Clearly identify source-only releases and untested platforms. Attach installers only when their provenance, signing status, and platform checks are documented.

## Before making the repository public

- Confirm the owner approved public visibility.
- When the repository becomes public, enable and verify protection for `main` before granting contributors write access.
- Check the entire history for credentials and private material; review screenshots and test fixtures.
- Confirm CI is green and clone/setup instructions work.
- Remove the initial-private status note from the README and verify the public links, repository topics, and issue templates.
- Check the license, dependency notices, contribution guide, and security-reporting path.
- Verify that software cost and paid API usage are both stated clearly.
- Keep competitor descriptions sourced and dated; do not claim benchmark results or screen-share invisibility that the project does not provide.

GitHub releases inherit repository visibility. Do not enable a public documentation site while the project is intended to remain private.

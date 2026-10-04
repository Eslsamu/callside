# Releasing Callside

## Source publication and installers

Publishing the source repository is separate from a version release or installer publication. Keep current development changes under Unreleased. Do not create tags, installer artifacts, or GitHub releases without an explicit release request.

## Development is separate from releasing

Small fixes and features accumulate under **Unreleased** in CHANGELOG.md. They do not automatically get a version bump, tag, DMG, ZIP, or GitHub release. Keep package.json and package-lock.json at the last release version until the owner requests a release.

- `npm run dev`: browser development.
- `npm run desktop`: desktop development without packaging.
- `npm run desktop:pack`: unpacked app for packaging-specific checks, in `.local/desktop-preview`. This does not build a DMG or change `release/Latest`.

Development previews are not distributable releases, even though their package version remains the last released version.

## Version numbers

Use `major.minor.patch` and group changes by user-facing scope:

- **Patch**, e.g. 0.6.1: bug fixes and small compatible improvements.
- **Minor**, e.g. 0.7.0: a meaningful feature release containing multiple completed changes. While below 1.0, breaking changes also require a minor version and explicit migration notes.
- **Major**, e.g. 1.0.0: the first declared stable release; subsequent breaking changes increment the major version.
- Optional release candidates use a suffix such as 0.7.0-rc.1 and are built only when explicitly requested.

A commit is not a release. Never replace the files of an already distributed version.

## Versioned release checklist

1. Obtain an explicit request to prepare the next version release. Review the accumulated Unreleased changes and choose patch or minor accordingly.
2. Verify that only intended source, docs, and synthetic fixtures are included. Exclude credentials, real transcripts, profiles, and recordings from the tree and history.
3. Run the checks relevant to the release, including `npm run check` and desktop checks on the target OS.
4. Bump once using `npm version patch --no-git-tag-version` or `npm version minor --no-git-tag-version`. Move Unreleased notes into a dated version section, leaving an empty Unreleased section for future work.
5. Commit the reviewed release state. For an explicitly requested local test release, run `npm run desktop:dist -- --version <version>`. For public distribution with Developer ID signing and notarization, run `npm run desktop:release -- --version <version>`.
6. Installer commands require the version to match package.json and refuse to overwrite existing DMG/ZIP artifacts. Outputs go into `release/v<version>`; only completed release builds update `release/Latest`. A failed build that leaves artifacts requires inspecting and removing only its incomplete outputs before retrying; never remove a distributed release to bypass the guard.
7. Verify the packaged app and installer. Record signing/notarization status and platform limitations. With publishing authorization, tag the verified commit as `v<version>` and publish matching release notes and artifacts. Build commands do not publish automatically.

See [macOS installation and signing](macos-installer.md) for platform requirements.

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

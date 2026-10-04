# Callside working instructions

## Development and releases

- Routine fixes and features are development work, not releases. Do not bump versions, create tags, build DMGs/ZIPs, publish releases, or update release artifacts unless the user explicitly requests a version release or installer build.
- Put user-visible changes under `Unreleased` in CHANGELOG.md. Keep package.json and package-lock.json at the last release version until release preparation is requested.
- Use `npm run dev` or `npm run desktop` for routine testing. If packaged behavior must be tested, use `npm run desktop:pack`: an unpacked preview under `.local/desktop-preview`, with no installer or change to `release/Latest`.
- Batch completed changes into a release. Follow docs/RELEASING.md, bump the version once, and move Unreleased entries into that version's dated section.
- Never overwrite an existing release's distribution artifacts. A correction to a shipped build needs a new patch version.
- Building a release does not authorize publishing it or changing repository visibility.

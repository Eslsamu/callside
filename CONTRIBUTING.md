# Contributing to Callside

Small, reviewable contributions are welcome. Explain the user problem, the resulting behavior, and how you verified the change. For larger changes, discuss the intended approach in an issue first.

See the [roadmap](docs/ROADMAP.md) for current priorities and [community conduct](CODE_OF_CONDUCT.md) for participation guidelines. While the repository is private, contributors need access from the owner; the public fork-and-pull-request workflow applies after publication.

## Contribution workflow

1. Search existing issues and discuss larger changes before implementation.
2. Create a branch for one focused change (or fork the project when it is public).
3. Use synthetic data and the demo to develop without paid API calls.
4. Run the relevant checks below and describe their limits in the pull request.
5. Update documentation when setup, costs, permissions, or behavior change.

Documentation corrections, accessibility improvements, regression tests, and reproducible platform reports are useful first contributions. Please avoid promotional text in the application UI. Discoverability and product comparisons belong in the README and documentation, with sources and honest limits.

## Local setup

Use Node.js 22.12 or newer.

```sh
npm ci
npx playwright install chromium
npm run dev
```

Use demo mode for UI work. Real API calls are optional and incur charges on your own project. Never include your API key, `.env`, audio recordings, exported calls, or private customer context in an issue or pull request.

## Before opening a pull request

```sh
npm run check
```

- Add tests for changed behavior, particularly capture cleanup, transcript ordering, request cancellation, and provider errors.
- Keep shared payloads in `shared/types.ts` and update `docs/CONTRACT.md` when the protocol changes.
- Document platform-specific capture limits honestly. A fixture passing does not prove real device capture works.
- Keep provider secrets in the server. Never put a provider API key into a `VITE_` environment variable or a renderer bundle.
- Make recording state, demo state, and errors visible to the user.
- Preserve keyboard access and meaningful labels for buttons and form controls.
- Use readable prose without em dashes.

The public API boundary is described in [the contract](docs/CONTRACT.md). [Architecture](docs/ARCHITECTURE.md) describes where to add providers. [Testing](docs/TESTING.md) explains automated and manual checks.

Maintainers should follow [Releasing](docs/RELEASING.md) for version tags, packages, and the eventual public release.

By submitting a contribution, you agree that it may be distributed under this repository's MIT license.

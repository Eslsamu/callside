# Contributing to Callside

Small, reviewable contributions are welcome. Explain the user problem, the resulting behavior, and how you verified the change. For larger changes, discuss the intended approach in an issue first.

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

By submitting a contribution, you agree that it may be distributed under this repository's MIT license.

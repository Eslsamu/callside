# Security

Callside is designed as a local application used by one person on their own computer. It is not designed to be exposed to the public internet or shared between mutually untrusted users.

## Data flow

Real capture sends selected microphone/system audio to OpenAI for transcription. Answer requests send the configured prompt, context, recent transcript, typed question, and recent suggestions. The browser/Electron renderer communicates with a local server, and only that server calls OpenAI with the provider key.

UI-entered keys live in server memory until the server process exits or the key is replaced. In the desktop app, **Remember API key on this device** additionally saves ciphertext in `openai-key.enc` under Electron's per-user app data directory. Electron's asynchronous `safeStorage` API uses the OS encryption provider, including Keychain on macOS. The encrypted file is outside the repository, written atomically with owner-only permissions, and loaded into the local server on startup. Keys are never returned by bootstrap or key-management responses, and are excluded from templates and exports. Session-only replacement and **Remove API key** delete the saved ciphertext. Unavailable encryption and Linux's `basic_text` backend are rejected, with no plaintext fallback. A corrupt or locked saved key does not prevent opening the app; the UI allows replacing or removing it.

Protection depends on the OS provider and local account security. Unsigned macOS test builds may trigger Keychain access prompts again after an update; stable code signing is needed for consistent trust across releases. See [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage). Environment keys are read from the environment or a local `.env` file and may load again on a later launch after removing a UI key. The repository ignores `.env` files except the empty example. Never commit a real key, place it in browser storage, or prefix it with `VITE_`.

Session transcripts and suggestions stay in memory unless the user exports them. Exported JSON/Markdown are ordinary files containing conversation content. This application does not control their later storage, backups, or sharing. OpenAI processes submitted data under the API project's applicable policies; local memory handling does not determine provider-side retention.

The optional **Save template** action stores settings, prompts, and background context in the renderer's `localStorage`. It excludes keys, transcripts, and suggestions. This is ordinary local browser storage, not encrypted secret storage. **Reset** removes the template. Take care when saving confidential context on a shared device.

## Local server boundary

The server binds to loopback, validates request origins, and requires a per-process token for protected API routes. The token protects against ordinary cross-origin web requests. It is not a defense against malicious local software, a compromised browser extension, or an attacker already able to read the local process or renderer.

Do not put the server behind a public reverse proxy, enable permissive CORS, or forward its port. A hosted version would need separate user authentication, authorization, key isolation, storage controls, TLS, and abuse protection.

The Electron renderer uses an isolated preload bridge with a narrow interface. Review changes to permissions, navigation, IPC, and capture handlers with particular care. Do not enable Node integration in the renderer.

## Reporting a vulnerability

If the published repository offers **Security → Report a vulnerability**, use that private reporting channel. If private reporting has not been enabled, ask a repository maintainer for a private contact method without posting exploit details or sensitive data in a public issue. Never attach API keys, raw private audio, or identifiable call transcripts.

Include affected versions, a minimal reproduction with synthetic data, the expected security boundary, and the impact. There is no guaranteed response time or paid bug bounty.

If a key is exposed, revoke it in the provider dashboard and create a new one. Removing the file from the latest commit is not enough to remove it from Git history or previous clones.

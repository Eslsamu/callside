# macOS installer

## Install

The current installer supports **Apple Silicon Macs running macOS 14 or later**.

1. Open the versioned Callside DMG.
2. Drag Callside into Applications.
3. Eject the disk image and open Callside from Applications.
4. In Settings → Audio sources, select **Use local audio + ChatGPT subscription**.
5. Click **Download and prepare models**. Whisper downloads about 574 MB; speaker labeling downloads additional files. Progress is shown. Internet is needed for initial setup.
6. Connect your ChatGPT account. Start a call and grant microphone/system-audio permissions when macOS requests them.

The installer includes both local audio runtimes. End users do not need Homebrew, Xcode, Python, or Node. Models persist outside the app bundle, so replacing the app does not remove them. Whisper uses the app's Application Support/models directory; FluidAudio manages its own persistent cache. Setup never captures audio.

The current local test build uses the available Apple Development certificate and **is not notarized for public distribution**. Developer ID signing and Apple notarization remain a public-release prerequisite.

## Build from source

Build installers only for explicitly requested releases, after setting the matching package version. For routine changes use `npm run desktop`; packaged previews use `npm run desktop:pack`. Follow [the release policy](RELEASING.md).

Build requirements (developers only): Apple Silicon Mac, Xcode/Swift, CMake, Node 22.12+, npm, Git, and internet access.

```sh
npm ci
npm run desktop:dist -- --version <version>
```

The build pins whisper.cpp and FluidAudio revisions, compiles an arm64 Whisper server with embedded Metal support and static ggml/Whisper libraries, and packages both native executables with their licenses. Whisper downloads are checked against a pinned SHA-256 before becoming usable.

Outputs in `release/v<version>/`:

- `Callside-<version>-mac-arm64.dmg`: drag-to-Applications installer.
- `Callside-<version>-mac-arm64.zip`: update payload.
- `latest-mac.yml` and blockmaps: update metadata.
- `mac-arm64/Callside.app`: unpacked app.

Build commands never publish automatically. Set `DEVELOPER_DIR` if Xcode is installed at a nonstandard path.

## Public signing and notarization

Use a **Developer ID Application** certificate. Set `CSC_NAME` when multiple identities exist. Store notarization credentials using Apple's Keychain workflow and set `APPLE_KEYCHAIN_PROFILE` to that profile. Protected Apple ID or App Store Connect API environment variables are also supported by electron-builder.

Never commit certificates, private keys, passwords, or GitHub tokens, or put them in the app's update configuration.

```sh
npm run desktop:release -- --version <version>
```

This refuses to proceed without Developer ID and notarization configuration. electron-builder submits and staples the app before generating artifacts. Verify the result:

```sh
codesign --verify --deep --strict release/v<version>/mac-arm64/Callside.app
xcrun stapler validate release/v<version>/mac-arm64/Callside.app
spctl --assess --type execute --verbose release/v<version>/mac-arm64/Callside.app
hdiutil verify release/v<version>/Callside-<version>-mac-arm64.dmg
```

## Updates

Installed builds check GitHub Releases on startup and download available updates. Settings shows the version, download state, and **Restart and update**. Installation is blocked during calls, answer generation, and model setup. Updates never restart automatically on quit.

The app uses the public `Eslsamu/callside` release feed without embedded GitHub credentials. Source-only releases do not provide an installable update. Publish the matching ZIP, blockmaps, and `latest-mac.yml` in a public, non-draft release once authorized. Keep the signing team consistent across updates.

Updater lifecycle and restart protection are tested locally. A real old-version → new-version update still needs verification against a public signed release feed. Building an installer does not publish a release.

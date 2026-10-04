# macOS installer

## Install the community build

Supports **Apple Silicon Macs (M1 or newer) running macOS 14 or later**.

1. Download the DMG from [Callside GitHub Releases](https://github.com/Eslsamu/callside/releases). Check the version and the published SHA-256 checksum if desired.
2. Open the DMG, drag Callside into Applications, and eject the disk image.
3. Open Callside from Applications. This community build is **not notarized by Apple** and has no Apple-verified Developer ID. An ad-hoc signature provides bundle integrity, not verified publisher identity.
4. If macOS blocks it because the developer cannot be verified or Apple cannot check it, dismiss the message. If you trust the download, open **System Settings → Privacy & Security**, find the Callside message, and choose **Open Anyway**. Confirm the app-specific prompt. See [Apple's instructions](https://support.apple.com/en-ie/102445). Managed computers may prevent this; ask their administrator. Do not disable Gatekeeper globally. A warning that software is damaged or contains malware is a different condition; do not treat every warning as routine.
5. In **Settings → Audio sources**, click **Download and prepare models**. Whisper downloads about 574 MB; speaker labeling downloads additional files. Internet is needed for setup. Models remain on this computer between sessions.
6. Select **Use local audio + ChatGPT subscription** and connect an eligible account, or choose API billing and add your OpenAI key. Local audio processing is free of API charges; cloud suggestions still use plan limits or API credit.
7. Start a call and grant the microphone and screen/system-audio permissions macOS requests. Share only audio you intend to transcribe. If capture fails, follow [audio troubleshooting](TROUBLESHOOTING.md).

The installer includes both local audio runtimes. Users do not need Homebrew,
Xcode, Python, or Node. Setup never captures audio. Whisper stores models under
Application Support; FluidAudio maintains its own persistent cache.

## Community updates and limitations

Automatic updating is disabled for community builds. Download a new DMG, quit
Callside, and replace the app in Applications. Models, templates, and stored
credentials live outside the app bundle and are retained. macOS may ask for
permissions or Keychain access again because the app has no stable Developer ID.

This release is tested on the maintainer's Apple Silicon Mac using an isolated
profile and packaged-app checks. It is not certification of every Mac, meeting
application, or permission configuration. A second physical Mac remains a useful
acceptance check. Windows and Intel Mac support are not claimed by this DMG.

## Verify the download

Download `SHA256SUMS.txt` beside the DMG, put both in the same folder, then run:

```sh
shasum -a 256 -c SHA256SUMS.txt
```

The checksum detects a changed or incomplete file; it is not a substitute for
verified publisher signing. Obtain both files from the project's GitHub release.

## Build from source

Build installers only for explicitly requested releases, after setting the matching package version. For routine changes use `npm run desktop`; packaged previews use `npm run desktop:pack`. Follow [the release policy](RELEASING.md).

Build requirements (developers only): Apple Silicon Mac, Xcode/Swift, CMake, Node 22.12+, npm, Git, and internet access.

```sh
npm ci
npm run desktop:community -- --version <version>
```

The build pins whisper.cpp and FluidAudio revisions, compiles an arm64 Whisper server with embedded Metal support and static ggml/Whisper libraries, and packages both native executables with their licenses. Whisper downloads are checked against a pinned SHA-256 before becoming usable.

Community outputs in `release/v<version>/`:

- `Callside-<version>-mac-arm64.dmg`: drag-to-Applications installer.
- `mac-arm64/Callside.app`: unpacked app.

Build commands never publish automatically. Set `DEVELOPER_DIR` if Xcode is installed at a nonstandard path.

## Optional Developer ID signing and notarization

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

## Signed-release updates

Future Developer ID-signed builds check GitHub Releases on startup and download available updates. Settings shows the version, download state, and **Restart and update**. Installation is blocked during calls, answer generation, and model setup. Updates never restart automatically on quit.

That update channel uses the public `Eslsamu/callside` release feed without embedded GitHub credentials. Source-only releases do not provide an installable update. Publish the matching ZIP, blockmaps, and `latest-mac.yml` in a public, non-draft release once authorized. Keep the signing team consistent across updates.

Updater lifecycle and restart protection are tested locally. This channel is disabled in community builds, which publish no automatic-update metadata. A real old-version → new-version update still needs verification against a public signed release feed. Building an installer does not publish a release.

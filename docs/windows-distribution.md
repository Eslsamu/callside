# Windows public distribution

Windows QA artifacts are unsigned development previews. They are not public
release installers. The signed release path is prepared, but signing is not yet
activated and the reported Google Safe Browsing block is not yet cleared.

## Code signing policy

The repository owner [Eslsamu](https://github.com/Eslsamu) reviews and approves
Windows releases. Changes from other contributors require maintainer review.
Signing credentials belong in a protected GitHub `windows-release` environment,
available only to approved builds from `main`. Require the owner's approval on
that environment before adding credentials. Use MFA for the signing account.

Public Windows builds must have valid, timestamped Authenticode signatures for
the installer, uninstaller, Callside executable, bundled Whisper executable and DLLs.
The pipeline rejects missing credentials, unsigned files and a publisher that
does not match the configured certificate. It scans the final files with updated
Microsoft Defender signatures and records the source commit and SHA-256 hashes.
The update client continues to verify the publisher of downloaded updates.

A signature identifies a publisher and protects file integrity. It does not
guarantee that a browser or antivirus service will accept a download.

## Activate a signing provider

No signing subscription or certificate is configured in this repository.

- **Free OSS option:** apply to [SignPath Foundation](https://signpath.org/apply.html).
  Acceptance is discretionary and requires compliance with its [conditions](https://signpath.org/terms.html).
  The project is new, so acceptance should not be assumed. Its restriction on
  signing upstream binaries must be resolved for the bundled Whisper executable.
  SignPath requires its own trusted-build integration; a Foundation account is
  not a `.pfx` certificate and cannot be used with the certificate mode below.
  Do not claim SignPath sponsorship before acceptance. Add the approved
  integration and attribution after onboarding.
- **Microsoft Artifact Signing:** identity verification and a paid account are
  required. The `azure` mode below uses the installed electron-builder 26
  integration. A paid subscription must be approved by the repository owner.
- **Existing trusted certificate:** `certificate` mode supports the certificate
  format accepted by electron-builder. A self-signed development certificate is
  not a substitute for a trusted public publisher.

Create the protected GitHub environment `windows-release` with these values:

| Setting                                                     | Kind     | Value                                                             |
| ----------------------------------------------------------- | -------- | ----------------------------------------------------------------- |
| `WINDOWS_SIGNING_PROVIDER`                                  | Variable | `azure` or `certificate`                                          |
| `WINDOWS_PUBLISHER_NAME`                                    | Variable | Exact certificate publisher name                                  |
| `AZURE_SIGNING_ENDPOINT`                                    | Variable | Official regional HTTPS signing endpoint; Azure only              |
| `AZURE_SIGNING_ACCOUNT`                                     | Variable | Signing account name; Azure only                                  |
| `AZURE_SIGNING_PROFILE`                                     | Variable | Public-trust certificate profile; Azure only                      |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | Secrets  | Service principal with signing access to that profile; Azure only |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`                      | Secrets  | Certificate and password; certificate mode only                   |

Grant the Azure identity the Certificate Profile Signer role on the relevant
profile only. Do not grant subscription-wide administrator access. Never commit
keys, certificate passwords or signing tokens.

## Build and publish

1. Complete signing setup and the Windows hardware QA. Follow
   [RELEASING.md](RELEASING.md) for an explicitly requested version release.
2. Dispatch **Windows signed release candidate** on `main`, passing the approved
   package version. It builds the normal Callside app with bundled local models.
   It does not publish a GitHub release or create a tag.
3. Review `SIGNATURES.json`, the Defender report and `BUILD.json`. The signature
   check extracts the actual portable ZIP and checks those shipped executables.
4. Publish the exact verified, versioned installer and portable ZIP as **separate
   GitHub Release assets**, alongside `SHA256SUMS.txt`, `BUILD.json`,
   `SIGNATURES.json`, `latest.yml` and generated blockmaps. Do not distribute the
   outer Actions artifact ZIP as the public installer. Do not modify signed
   files, regenerate update metadata after publication or overwrite a release.
5. Verify the public download in Chrome and Firefox on Windows with their normal
   protections enabled, then installation, launch and uninstall. Record any
   warning separately from application correctness. Signing and a successful
   antivirus scan do not establish this browser acceptance result.

Routine changes continue to use development builds. To test the release guards
without signing, building an installer or calling a paid service, dispatch
**Windows preflight checks** with `release_checks=true`.

## Browser or antivirus false positives

Collect the exact warning, the release URL, source commit and file hash. Distinguish
an unfamiliar-publisher/low-reputation prompt from a malware/download verdict.
Compare the user's file hash to the published checksum. Retain scan evidence
and request review from the service that made the classification.

Chrome and Firefox can both rely on Google Safe Browsing; two warnings need not
be independent antivirus detections. A review of the October 10 unsigned QA
artifact was submitted to Google on October 11, 2026. That submission is not
confirmation that the block has been removed, and a new signed artifact needs
its own download verification.

### October 11 installer isolation

The maintainer tested copies of the October 10 build in Chrome on macOS with
normal browser protections. These are user-observed download results, not
Windows installation or runtime results:

| Download                                              | Result                                                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------- |
| Complete original portable ZIP, including Whisper     | Download allowed                                                            |
| Portable ZIP with only the Whisper executable removed | Download allowed; diagnostic copy is not functional for local transcription |
| ZIP containing only the unchanged installer           | Dangerous download blocked                                                  |
| Latest retry of the original combined artifact        | Unverified; not visible in the maintainer's download history                |

The [portable comparison](https://github.com/Eslsamu/callside/actions/runs/38141683093)
and [installer-only comparison](https://github.com/Eslsamu/callside/actions/runs/38142714711)
retain hashes and provenance. Diagnostic artifacts expire after seven days.

Extraction of the original NSIS installer found all 734 portable app files
byte-identical, plus `resources/elevate.exe`. Its six installer plugins and the
elevation helper match the cached upstream electron-builder NSIS binaries.
Existing VirusTotal reports for the helper, uninstaller and five plugins had
zero detections when checked. The optional
[SpiderBanner.dll installer banner](https://www.virustotal.com/gui/file/996a259e53ca18b89ec36d038c40148957c978c0fd600a268497d4c92f882a93)
had one detection from Cynet out of 69 engines; Google's engine timed out.
This does not identify the reason for the Safe Browsing block.

The next test-build configuration uses the standard NSIS wizard without the
one-click banner, omits the unused elevation helper because preview updates are
disabled, and requires the user to open the app after installation. It provides
the full portable app separately for runtime QA. These are packaging changes,
not evidence of browser clearance. Confirm the generated contents and repeat
the download check after an explicitly requested installer build. Keep the
Google review open until the reported block is resolved.

Do not disable security protections, repackage files to conceal their contents,
or instruct public users to bypass malware warnings as the installation flow.

See [privacy and data handling](../README.md#privacy-and-boundaries) and
[security reporting](../SECURITY.md).

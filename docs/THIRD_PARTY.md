# Third-party components and test assets

Callside's own code is MIT-licensed. Dependencies, models, and research recordings
retain their original licenses. Publishing the source does not publish locally
cached model weights, native builds, credentials, or user recordings.

## Runtime components

| Component                                              | Source / version                                                                                                  | License and included notice                                                                                                        |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Production JavaScript packages                         | Exact versions and integrity hashes in package-lock.json                                                          | Collected upstream notices in public/licenses/npm-dependencies.txt                                                                 |
| Electron                                               | Version resolved by package-lock.json                                                                             | MIT and Chromium third-party notices shipped by Electron; preserve LICENSE and LICENSES.chromium.html when distributing installers |
| DM Sans                                                | @fontsource-variable/dm-sans                                                                                      | SIL OFL-1.1, public/licenses/dm-sans-OFL.txt                                                                                       |
| Lucide                                                 | lucide-react                                                                                                      | ISC/MIT, public/licenses/lucide-ISC.txt                                                                                            |
| whisper.cpp / ggml                                     | [v1.9.2, revision 306c88f](https://github.com/ggml-org/whisper.cpp/tree/306c88f4d1286aec1bf96e544632897886af5501) | MIT, desktop/licenses/Whisper-GGML-MIT.txt; compiled separately by runtime build scripts                                           |
| FluidAudio                                             | [revision 0b1f462](https://github.com/FluidInference/FluidAudio/tree/0b1f46289fe27d95b5e66ad8be46e64f5ee02ae7)    | Apache-2.0 and upstream component notices, desktop/licenses/FluidAudio/                                                            |
| LS-EEND                                                | [Audio-WestlakeU/FS-EEND](https://github.com/Audio-WestlakeU/FS-EEND/tree/main/LS-EEND)                           | MIT; desktop/licenses/LS-EEND-MIT.txt and native/windows/diarization/frontend-NOTICE.txt                                           |
| ONNX Runtime Web/Common                                | [v1.30.0](https://github.com/microsoft/onnxruntime/tree/v1.30.0)                                                  | MIT, public/licenses/onnxruntime-MIT.txt                                                                                           |
| MinGW / GCC runtime, cross-built Windows previews only | Build toolchain, recorded in native binary provenance                                                             | License and runtime-exception texts under native/windows/licenses/; copied into Windows runtime builds                             |

The guid-typescript and lazy-val npm packages and their upstream repositories
provide ISC and MIT declarations respectively, but no standalone license texts.
Their declarations, authors, and source locations are retained in the dependency
notices. They are unmodified dependencies, not Callside-authored code.

## Downloaded models

Model weights are excluded from Git. Downloads and provenance are defined in
server/whisper-model.ts, scripts/cohere-setup.mjs, the pinned FluidAudio runtime,
and scripts/windows-speakers-setup.mjs. The Windows preview can bundle verified
Whisper and LS-EEND weights; retain their notices when distributing it.

- Whisper: [OpenAI Whisper](https://github.com/openai/whisper), MIT, converted
  large-v3-turbo Q5 weights from the pinned whisper.cpp model repository.
- macOS speaker labels: [FluidInference LS-EEND CoreML](https://huggingface.co/FluidInference/ls-eend-coreml), AMI variant, via FluidAudio.
- Windows speaker labels: [LS-EEND ONNX](https://huggingface.co/GradientDescent2718/LS-EEND-ONNX), revision and checksums in the setup script. See native/windows/diarization/README.md.
- Optional Cohere comparison: model/runtime provenance is documented in
  [the comparison guide](local-comparison.md). It is installed separately and
  is not included in normal desktop packages. Review the upstream model card
  and license when changing models or redistributing weights.

## Included audio and images

Both Windows playback fixtures are excerpts of the **AMI Meeting Corpus**,
meeting ES2004a. The corpus and annotations use
[CC BY 4.0](https://groups.inf.ed.ac.uk/ami/corpus/license.shtml).
The 50-second conversation and 5.32-second computer-audio check are cropped and
resampled to mono 24 kHz PCM. Full attribution, source locations, and changes are
in public/windows-speakers-test-LICENSE.txt. The recording and reference words
remain CC BY 4.0, independently of Callside's MIT license. No endorsement is implied.

The README screenshot contains the application's synthetic demo conversation.
Callside's icon is an authored SVG. See [asset provenance](assets/README.md).
The historical English/German benchmark JSON contains synthetic reference text
and measurements, not audio. No personal call recordings are included.

## Updating dependencies or packaging

Review changed licenses and refresh notices alongside dependency updates. Preserve
public/licenses in the built dist folder, desktop/licenses in desktop builds,
and fixture attribution beside the audio. Native build scripts also copy runtime
licenses. A source-publication review does not replace the signing, platform,
and redistribution checks required for each future installer release.

# Local diarization comparison — 2026-10-02

## Scope

CPU-only runs on an Apple M1 Pro (10 CPU cores), 16 GB RAM, macOS 26.5.1.
Three 90-second excerpts from two AMI test meetings, each with four annotated
speakers. Excerpts were selected for four-speaker coverage and many turns, before
evaluating predictions. They are deliberately challenging and not a random sample.

Audio: official Mix-Headset WAV recordings from the
[FluidInference AMI mirror](https://huggingface.co/datasets/FluidInference/ami-corpus-mirror).
Ground truth: [pyannote AMI only-words RTTMs](https://github.com/pyannote/AMI-diarization-setup/tree/main/only_words/rttms/test).
These are mixed headset recordings, not separate input channels supplied to the models.
MP3 copies are provided locally for listening; inference used the original WAV crops.

## Configuration

- FluidAudio commit `0b1f46289fe27d95b5e66ad8be46e64f5ee02ae7`, release build.
- LS-EEND: CoreML CPU-only, 500 ms steps, default threshold; AMI and DIHARD3 variants.
  The AMI model is specialized for this corpus and has four speaker slots. Its
  results are not proof of generalization to arbitrary calls or larger meetings.
- Diart 0.9.2: default `pyannote/segmentation` and `pyannote/embedding`, CPU,
  two PyTorch threads, 500 ms steps, two-second configured latency, two seconds
  of end padding. No tuning on these recordings.
- Independent model state for each clip. No Whisper/Cohere inference concurrently.
- Faster-than-live file replay. Timings are processing throughput, not measured
  microphone-to-final-label latency. LS-EEND used its complete-file interface
  driving its streaming model. Diart used `StreamingInference` and `FileAudioSource`.

## Results

Each cell lists detected speaker count / reference speaker count, followed by DER.
DER includes overlap, uses zero boundary collar, and optimally maps anonymous
speaker IDs to reference identities. It is not transcription word error rate.

| Excerpt (source offset) | LS-EEND AMI | LS-EEND DIHARD3 | Diart      |
| ----------------------- | ----------- | --------------- | ---------- |
| ES2004a (570–660 s)     | 4/4; 20.5%  | 3/4; 33.9%      | 2/4; 40.3% |
| ES2004a (945–1035 s)    | 3/4; 22.2%  | 3/4; 31.5%      | 2/4; 44.5% |
| IS1009a (495–585 s)     | 4/4; 24.9%  | 2/4; 52.4%      | 3/4; 34.1% |

| Resource measurement               | LS-EEND AMI | LS-EEND DIHARD3 | Diart         |
| ---------------------------------- | ----------- | --------------- | ------------- |
| Processing per 90 seconds of audio | 0.62–0.71 s | 0.69–0.70 s     | 12.78–14.17 s |
| Peak process RSS                   | 85–129 MiB  | 90–131 MiB      | 567 MiB       |

Model loading is excluded from processing times; RSS includes runtime/model loading.
Diart RSS is a process high-water mark across its sequential runs. CoreML CPU-only
does not impose the same two-thread limit, so this compares practical CPU setups,
not identical thread allocations. These measurements do not establish total app
memory or performance during simultaneous local transcription.

## Substantial errors against the reference

Times below are relative to each excerpt. These observations come from aligned
reference and hypothesis labels, not a fresh human auditory annotation.

- **ES2004a / 570 s:** Diart collapsed four people into two identities. At
  28.51–33.44 s it assigned an approximately five-second MEE014 turn to FEE013.
  LS-EEND AMI preserved four identities but confused MEO015 with MEE014 at
  8.70–10.85 s. Its largest error component was missed speech (12.8 speaker-seconds),
  rather than confusion (6.1 speaker-seconds).
- **ES2004a / 945 s:** LS-EEND AMI missed one identity and failed to retain both
  speakers during the overlap at approximately 40.9–43.9 s. Diart again produced
  only two identities and assigned FEE016's 15.29–20.10 s turn to MEE014.
- **IS1009a / 495 s:** LS-EEND AMI found four identities but confused FIO087 with
  FIO084 at 26.10–29.20 s. Diart found only three identities. The general DIHARD3
  variant was worse here, collapsing the conversation into two identities.

## Decision

LS-EEND AMI is the strongest candidate in this small, matching-domain test and
has a much smaller measured resource footprint than our Python Community-1 test.
However, DIHARD3's worse result shows that choosing the right model/domain matters.
Do not claim LS-EEND universally beats Diart, or that four speaker slots establish
support for arbitrary speaker counts.

Keep diarization optional and asynchronous. Supply confirmed historical labels to
the answer model and explicitly mark recent or ambiguous speech as pending. The
next integration gate is a realistic live replay plus concurrent local ASR, with
speaker-label stability and delay measured over longer and out-of-domain calls.

## Reproduction and artifacts

Local artifacts are in `.local/diarization-suite/`: source recordings, cropped WAV
and MP3 clips, cropped RTTMs, `manifest.json`, per-engine JSON/logs and `scores.json`.
These benchmark recordings and model weights are not committed. A separate licensed 50-second AMI excerpt is included under `public/windows-speakers-test.wav` for the Windows guided check; its attribution and changes are documented beside it.

Diart was installed into a separate environment because its dependencies differ
from Community-1:

```sh
uv venv --python 3.11 .local/diart-venv
uv pip install --python .local/diart-venv/bin/python diart==0.9.2 \
  numpy==1.26.4 torch==2.5.1 torchaudio==2.5.1 pyannote.audio==3.4.0 \
  'huggingface-hub<1' 'matplotlib<3.9' 'pandas<3'
.local/diart-venv/bin/python scripts/benchmark-diart.py .local/diarization-suite
.local/diarization-venv/bin/python scripts/score-diarization-suite.py .local/diarization-suite
```

Use authorized Hugging Face access for the model repositories. For LS-EEND, build
the pinned FluidAudio revision with `swift build -c release --product fluidaudiocli`
and run `fluidaudiocli lseend CLIP.wav --variant ami --step-size 500ms --output OUT.json`.
Replace `ami` with `dihard3` for the second variant. `/usr/bin/time -l` records RSS.

## Cloud comparison on the same clips

Six API requests, one full 90-second WAV per provider per excerpt. OpenAI used
`gpt-4o-transcribe-diarize`, `diarized_json`, automatic chunking and English.
ElevenLabs used `scribe_v2`, diarization enabled, English, word timestamps and
audio-event tagging disabled. Neither received a speaker count, reference text,
or known-speaker voice samples. This is model-level whole-clip testing, not a
replay of Callside's 12-second background batches with session voice references.

| Excerpt         | OpenAI speakers / DER / response | ElevenLabs speakers / DER / response |
| --------------- | -------------------------------- | ------------------------------------ |
| ES2004a / 570 s | 5 / 28.1% / 49.54 s              | 4 / 40.8% / 5.75 s                   |
| ES2004a / 945 s | 4 / 31.8% / 45.00 s              | 3 / 40.7% / 5.97 s                   |
| IS1009a / 495 s | 6 / 36.0% / 38.49 s              | 3 / 36.1% / 5.95 s                   |

Response time includes HTTP upload through completed JSON, with models called
sequentially. Local timings exclude model loading and neither measure is live
speaker-label latency. All reference excerpts contain four people.

### Interpretation beyond DER

- **OpenAI:** lowest speaker-confusion duration of these three engines (OpenAI,
  ElevenLabs, LS-EEND AMI) on the first two clips: 3.39 and 4.10 speaker-seconds.
  It nevertheless produced an extra identity on the first clip and two extra
  identities on the third. On the third clip, roughly 86.48–89.92 s of the turn
  about adding a light to the remote was assigned to the wrong reference person.
- **ElevenLabs:** substantially quicker responses, but only three identities
  for two of the four-person excerpts. On the first clip it attributed much of
  the question about undercutting the price / making the product look cheap
  (approximately 38.98–43.51 s, with a short gap) to FEE013 instead of FEE016.
  On the second it assigned MEO015's 8.06–9.40 s speech to MEE014. On the third
  it confused FIO087 with FIO084 at 26.14–29.22 s.
- **LS-EEND AMI:** still has the lowest total DER on these excerpts. However,
  it is domain-specialized, and its lower DER does not mean it makes fewer
  wrong-person assignments: it covered more reference speech/overlap while
  OpenAI had less measured confusion on all three clips.

Scoring uses provider timestamps as returned. ElevenLabs' speaker-tagged spacing
intervals are included alongside words; omitting them artificially counted gaps
between words as missed speech. No inferred gap filling is applied. OpenAI uses
segment timestamps, and local diarizers use speech-activity intervals. Their
different timestamp granularity and overlap representation affect DER. Missing
reference speaker-time is not equivalent to missing transcript words.

These observations are comparisons with reference speaker annotations. We did
not perform a new word-by-word transcription-accuracy evaluation on these clips.
Retain OpenAI as the existing baseline; ElevenLabs is a promising lower-delay
candidate but not an established accuracy upgrade. A short-chunk, persistent
identity comparison is required before switching Callside's production behavior.

Run the bounded cloud benchmark with keys in the ignored `.env` file:

```sh
node scripts/benchmark-cloud-diarization.mjs
.local/diarization-venv/bin/python scripts/score-diarization-suite.py .local/diarization-suite
```

Existing output files are skipped to prevent accidental repeat charges. Raw API
responses, text, timestamps, normalized segments and request durations are in
the per-clip `.openai.json` and `.elevenlabs.json` files; keys are never included.

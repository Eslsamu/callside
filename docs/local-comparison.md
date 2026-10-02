# Cohere versus Whisper local test

This experiment compares **Cohere Transcribe** with **Whisper large-v3-turbo Q5**, the baseline used by Callside's earlier local microphone test. Whisper is the model name; Wispr Flow is a separate product and is not being benchmarked here.

The test records once and replays the same audio separately through both local engines. It needs no API key or subscription. Both models are batch speech-recognition models used with short, repeated audio snapshots; this is a test of a practical live-transcription pipeline, not native streaming or speaker identification.

## Setup and run

The initial Cohere runtime requires an Apple Silicon Mac and `uv`, which prepares an isolated Python 3.11 environment. Allow several GB of free space for the runtime, a 1.51 GB Cohere model download, and the existing 574 MB Whisper model. The setup command prints the selected model and download details. Model downloads require network access; inference runs locally with model-loading network access disabled.

```sh
brew install whisper-cpp uv
npm ci
npm run local:setup
npm run local:compare
```

Keep the terminal running and open the printed address, normally **http://127.0.0.1:4321/local-compare**. The page does not activate the microphone on load.

1. Choose English or German. Cohere requires a language; this test does not use automatic detection.
2. Click **Start recording**, speak naturally for 15–30 seconds, then stop. A recording is limited to 60 seconds. Alternatively, select an audio file; it is decoded and converted to mono 16 kHz in the browser.
3. Optionally enter the exact words spoken in the reference field. An accurate reference makes the word-error comparison useful. Leave it empty if you only want to compare transcripts and speed.
4. Run the comparison. Each model receives its own replay paced at the recording's original speed. The replay is silent; it does not play audio through your speakers. Expect roughly twice the recording duration plus any processing backlog.
5. Compare the transcripts and timings. Download the JSON report if you want to retain it. Cancel stops the replay and active inference; retrying may reload a cancelled Cohere worker.

The next run reverses model order to help identify warm-up/order effects. The models stay loaded between runs. Ctrl+C stops the server and unloads them. These experiments do not change the normal Callside audio provider or your saved settings.

## What is measured

| Field                  | Meaning                                                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| First text             | Median phrase onset to its first nonempty result, including buffering and queueing.                                                            |
| Final delay            | Median and 95th percentile from the latest detected speech in a finalized snapshot to its result.                                              |
| Processing             | Sum of local engine request durations, including local transport.                                                                              |
| Processing/audio ratio | Total processing time divided by recording length, including repeated draft decoding. Below 1 alone does not guarantee a responsive interface. |
| Maximum queue          | Longest measured wait behind another inference request.                                                                                        |
| Drain                  | Time needed to finish pending speech after the recording's replay ends.                                                                        |
| Word error rate        | Word-level edit distance divided by reference word count. Lower is better; it can exceed 100%. Not computed without a reference.               |

Word scoring normalizes Unicode, case, and punctuation. It does not treat spelled-out numbers as equivalent to digits or judge whether a paraphrase preserves meaning. Review names, technical vocabulary, negations, and numbers yourself. Failed runs are explicitly marked; their partial transcripts do not establish model accuracy.

Cohere generation is limited to 256 output tokens per snapshot (up to 12 seconds in this pipeline).

The pipeline uses the same energy-based speech detector, 50 ms frames, a first draft after roughly 1.2 seconds, updates no sooner than every 0.8 seconds, a 0.5 second pause to finalize, and a 12 second turn limit. Outdated pending drafts are coalesced while final turns are retained. Because models run at different speeds, they can receive different intermediate snapshots of the same recording. The report includes the protocol, model/runtime metadata, hardware, audio hash, all measured requests, and results.

Timing is approximate. It excludes physical microphone latency, browser paint time, and model startup. It is affected by other processes and thermal conditions. This test does not measure CPU/GPU utilization or system memory peaks. It measures the specific local model/runtime configurations in the report, not every possible implementation of either architecture.

## Synthetic smoke results — October 2, 2026

One short macOS text-to-speech sample per language on this Apple M1 Pro, 16 GB Mac. Both models were loaded and warmed before the paced comparison; English ran Whisper first, German ran Cohere first. These are individual pipeline checks, not representative accuracy or latency benchmarks.

| Sample          | Model                     | First text | Final delay | Total processing / audio |
| --------------- | ------------------------- | ---------- | ----------- | ------------------------ |
| English, 6.31 s | Whisper large-v3-turbo Q5 | 2.17 s     | 1.48 s      | 1.04                     |
| English, 6.31 s | Cohere MLX 4-bit          | 2.73 s     | 0.30 s      | 0.49                     |
| German, 7.08 s  | Whisper large-v3-turbo Q5 | 2.12 s     | 1.65 s      | 1.06                     |
| German, 7.08 s  | Cohere MLX 4-bit          | 1.41 s     | 0.65 s      | 0.34                     |

The final transcripts matched between models. The scorer counted one formatting difference in each sample: `7` versus the reference's `seven`/`sieben`. First text was not consistently faster with Cohere, despite lower final delay in these samples. Each recording contained one finalized turn, so the median and 95th percentile final delays are the same observation.

Raw reports: [English](benchmarks/2026-10-02-en.json), [German](benchmarks/2026-10-02-de.json). References and exact model/runtime revisions are included. The voices were macOS Samantha and Anna; audio was converted to mono 16 kHz PCM before submitting it to the comparison route. They contain synthetic text only. The reported Cohere MLX peak allocation is not total process/system memory and is not a comparative RAM measurement.

**Recommendation:** proceed with natural English/German recordings in this test. Keep the current API transcription default until real speech, domain vocabulary, noise, and longer runs have been checked. This initial check does not establish diarization quality, native streaming, or a universally better model.

## Suggested real-speech tests

Try several recordings in each language:

- Natural speaking with names, a date, numbers, and a short explanation.
- A course or support question with domain-specific vocabulary.
- Long uninterrupted speech and short phrases separated by pauses.
- Background noise and distant microphone placement.
- A deliberate language switch, while keeping in mind Cohere's explicit-language limitation.

Use consented call audio for multi-person tests. Transcription quality is separate from diarization and echo cancellation: neither comparison engine identifies speakers. Synthetic speech checks the pipeline but cannot establish natural conversation quality.

## Data and security

Audio is kept in browser/server memory and sent only to the loopback server. Cohere communicates with its Python worker over private stdio; Whisper uses a loopback endpoint with a random private path. The comparison routes use Callside's existing origin and local-session-token checks. There is no cloud fallback and no API inference billing.

The app does not save recordings or reports automatically. A downloaded report includes transcript text and the reference you supplied, so review it before sharing. The selected Cohere weights are the pinned [community MLX 4-bit conversion](https://huggingface.co/lyzgeorge/cohere-transcribe-03-2026-mlx-4bit), not the full-precision official artifact. Its base revision and conversion revision are included in the report. Quantization and runtime differences are part of this device-level comparison.

Model files and the Python environment live under ignored `.local/`; they are not included in the repository or normal desktop builds.

## Overrides

- `LOCAL_COMPARE_PORT`: test server port (default 4321).
- `WHISPER_MODEL_PATH`: another local whisper.cpp model; its configuration is then a custom baseline.
- `WHISPER_SERVER_BIN`: path to the whisper.cpp server executable.
- `COHERE_MODEL_PATH`: local Cohere model directory compatible with the pinned MLX runtime.
- `COHERE_PYTHON`: absolute path to the prepared Python interpreter.

## Sources

- [Cohere Transcribe model card](https://huggingface.co/CohereLabs/cohere-transcribe-03-2026)
- [MLX Audio runtime](https://github.com/Blaizzy/mlx-audio)
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp)

The comparison work is tracked in [issue #21](https://github.com/Eslsamu/callside/issues/21). Real-speech evaluation is still required before changing Callside's default transcription provider.

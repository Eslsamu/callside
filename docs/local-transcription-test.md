# Local microphone test

This experiment runs Whisper on your computer. It needs no API key or subscription and makes no cloud inference requests. It tests microphone transcription and rough latency before integrating a local provider into the full call workflow.

## Run

Install [whisper.cpp](https://github.com/ggml-org/whisper.cpp) with its `whisper-server` executable. On macOS with Homebrew:

```sh
brew install whisper-cpp
npm install
npm run local:test
```

The first launch downloads the multilingual **large-v3-turbo Q5** model, about 574 MB, into the ignored `.local/models/` directory. Later launches use the same file. The model source is pinned to a revision of the [whisper.cpp model repository](https://huggingface.co/ggerganov/whisper.cpp). macOS uses Metal when supported. The model stays loaded, and a silent warm-up runs before the test URL is printed.

Open the printed URL, normally `http://127.0.0.1:4320/local-test`. Select German or English, click **Start microphone**, and allow microphone access. No separate Zoom, Meet, or Teams meeting is needed for this solo test.

Speak naturally for 30–60 seconds. Include a name, a date, a question, and a couple of short pauses. Click **Stop**, wait for the final phrase, then check the transcript. **Start a new test** clears the previous results. **Download test report** saves the transcript and measurements only when you click it.

Press Ctrl+C in the terminal to stop the server and unload the model. Leave the test page open while speaking. Reloading or closing it stops microphone capture and clears its transcript.

Optional overrides:

```sh
WHISPER_MODEL_PATH=/absolute/path/to/ggml-small.bin npm run local:test
LOCAL_TEST_PORT=4321 npm run local:test
WHISPER_SERVER_BIN=/absolute/path/to/whisper-server npm run local:test
```

## What the numbers mean

| Measurement                 | Meaning                                                                                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Latest speech → text        | Approximate time from the last detected speech in an audio snapshot to its text arriving at the browser callback. Includes pause detection, queueing, and inference. |
| Local processing            | Local HTTP request to the persistent Whisper engine and its response. Includes inference and small local transport overhead.                                         |
| First text in latest phrase | Approximate phrase onset to its first nonempty draft or final result. Includes initial buffering.                                                                    |
| Median final delay          | Median speech-to-text delay for finalized, nonempty phrases in this test.                                                                                            |
| Queue time in the report    | Time waiting behind an earlier local inference request.                                                                                                              |

These are coarse measurements, not word-aligned latency benchmarks. They use a simple energy-based speech detector, 50 ms audio batches, and browser clocks. Hardware input delay and browser paint are not calibrated. A draft can revise earlier words. A low processing time alone does not prove low perceived latency.

The first draft is requested after about 1.2 seconds of speech. Subsequent drafts replace the current phrase; a 0.5 second pause finalizes it. Continuous speech is split at 12 seconds. Inference is serialized, outdated pending drafts are replaced, and finalized phrases are queued. Excessive backlog stops the test with a visible error rather than silently discarding finalized speech.

## Scope and data

- Microphone only, one speaker labeled **Me** by input source. This does not evaluate acoustic speaker identification or diarization.
- No answer generation, cloud fallback, API billing, or subscription use in this test.
- Audio is sent only to loopback and processed in memory. It is not recorded to disk.
- Transcript text stays in the browser tab unless the report is downloaded. The local server retains only numeric timing samples in memory, capped at 2,000. A new test clears them; process exit also clears them.
- Both HTTP servers bind to `127.0.0.1`. The app uses its existing host, origin, and session-token checks. All native Whisper routes use a random private path that is never exposed to the renderer.
- Whisper is a batch ASR model used here with repeated short chunks. This experiment is not native token-by-token streaming and does not establish meeting accuracy until tested with real speech and call audio.

For the next comparison, use the same microphone, phrases, language, and noise conditions. Compare first readable text, corrections, names and numbers, and final delay. Synthetic speech verifies the audio pipeline; it does not establish real conversation quality.

## Initial local smoke measurement

On an Apple M1 Pro with 16 GB RAM, whisper.cpp 1.9.2, Metal, and the warmed large-v3-turbo Q5 model, a synthetic German voice passed through the browser's fake microphone, the actual AudioWorklet, and local inference on September 29, 2026:

| Observation                                                    | Measured range |
| -------------------------------------------------------------- | -------------- |
| Local processing per request                                   | 0.87–1.07 s    |
| First text per phrase                                          | 2.13–2.48 s    |
| Ongoing draft delay from the snapshot's latest detected speech | 0.88–1.11 s    |
| Final delay                                                    | 1.60–1.97 s    |

This was one short, repeated synthetic sample with two phrase segments, including a forced 12 second split and a stop during the following segment. It is a pipeline smoke measurement, not an accuracy benchmark or a claim about natural meeting audio. The source sentence was recognized in the longer snapshots, while partial words and cut boundaries were revised. No physical microphone or cloud inference was used for this verification.

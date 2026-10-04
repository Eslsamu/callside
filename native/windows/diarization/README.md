# Portable LS-EEND speaker runtime

The Windows preview uses LS-EEND AMI through ONNX Runtime Web's CPU WebAssembly
backend on a dedicated Node worker thread. It needs neither Python nor a GPU or
Microsoft runtime installation. It uses anonymous slots for at most four
speakers. Identities persist within a call; they are not enrolled real names.

Model: [GradientDescent2718/LS-EEND-ONNX](https://huggingface.co/GradientDescent2718/LS-EEND-ONNX),
revision `cc40a1e1242c148fbbc15c132e43b8ac15056e53`, AMI variant.
Original model/code: [Audio-WestlakeU/FS-EEND, LS-EEND](https://github.com/Audio-WestlakeU/FS-EEND/tree/main/LS-EEND).
The repository/model card declares MIT; the upstream license accompanies the model.
The AMI training/evaluation data have separate dataset terms. No training audio is
included in the model distribution.

## Packaging

Run `node scripts/windows-speakers-setup.mjs` to download and verify the pinned
42.4 MiB model. Include `ls_eend_ami_step.onnx`, its JSON sidecar, the notices, and
`provenance.json` from `.local/windows-diarization` under `resources/models/speakers`.
Pass the absolute ONNX path as `bundledSpeakerModel` to `startServer`, which passes
it as the third argument to `startSpeakerWorker`. Keep the normal macOS CoreML
runtime unless a portable model is explicitly supplied.

Include the `onnxruntime-web` and `onnxruntime-common` production dependencies.
Unpack them from ASAR so the WASM loader can read its companion files. Include
`dist-server/server/portable-speaker-worker.js` and its compiled imports. The model
is loaded from disk; the runtime does not download weights or send audio anywhere.

## Frontend and session behavior

PCM is mono signed 16-bit little-endian at 24 kHz. A centered low-pass FIR
decimator produces 8 kHz. Log-mel extraction follows the export's reference Python
streaming frontend: Hann window of 200 samples; FFT of 256; 80-sample hops; 23
Slaney mel bins; cumulative mean subtraction; ±7 context frames; subsampling by 10. **The model's metadata says `n_fft=1024`, but its Python frontend derives 256
from the window length.** Blindly using 1024 changes the features.

The six recurrent tensor groups persist across chunks. Decode begins after nine
model frames and flushes the pending tail on stop. Only the four real output
slots are exposed; boundary/dummy slots are discarded. Threshold is 0.5.
Only committed model time is returned, so the newest ~1 second remains pending.
Audio/feature buffers and returned history are bounded; recent 60-second history
is provided for attribution updates. The server enforces startup/inference
timeouts and terminates the dedicated worker when a call ends or fails.

## Verification, 2026-10-03

Actual WASM inference on an Apple M1 Pro, one WASM thread, using the same three
90-second/four-speaker AMI excerpts as `docs/local-diarization-results.md`:

| Clip                | Detected / reference speakers | DER, zero collar including overlap |
| ------------------- | ----------------------------- | ---------------------------------- |
| ES2004a, 570–660 s  | 4 / 4                         | 24.0%                              |
| ES2004a, 945–1035 s | 4 / 4                         | 22.6%                              |
| IS1009a, 495–585 s  | 4 / 4                         | 25.9%                              |

Processing was approximately 4.8 seconds per 90 seconds of audio, plus ~0.35
seconds to load the model. This is file replay throughput on macOS, **not measured
Windows microphone latency**, and excludes concurrent Whisper inference.
AMI is the model's matching domain; these results do not establish arbitrary-call
accuracy. Speaker labels remain experimental and should not delay suggestions.
The synthetic German Anna/Ben/Anna test was collapsed to one identity despite
correct speech boundaries, so it is unsuitable as a diarization pass criterion.
Use real voices to evaluate speaker identity, including a speaker returning later.

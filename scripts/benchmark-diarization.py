#!/usr/bin/env python3
"""CPU-only Community-1 benchmark. Audio never goes to an inference service."""
import argparse
import importlib.metadata
import json
import os
import platform
import resource
import sys
import time
from pathlib import Path

os.environ.setdefault("PYANNOTE_METRICS_ENABLED", "0")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio", type=Path, help="16 kHz WAV recording")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--chunk-seconds", type=float, default=12)
    parser.add_argument("--model", default="pyannote/speaker-diarization-community-1")
    args = parser.parse_args()
    if args.threads < 1 or args.chunk_seconds <= 0:
        parser.error("Threads and chunk duration must be positive")

    for name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
        os.environ[name] = str(args.threads)

    import soundfile as sf
    import torch
    from pyannote.audio import Pipeline

    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    audio, rate = sf.read(args.audio, dtype="float32", always_2d=True)
    if rate != 16000 or not len(audio):
        parser.error("Provide a nonempty 16 kHz WAV (resample with ffmpeg first)")
    waveform = torch.from_numpy(audio.mean(axis=1).copy()).unsqueeze(0)
    started = time.perf_counter()
    # Use the standard local Hugging Face login; never put tokens in reports.
    pipeline = Pipeline.from_pretrained(args.model)
    pipeline.to(torch.device("cpu"))
    load_seconds = time.perf_counter() - started

    def run(samples, offset=0):
        wall = time.perf_counter()
        cpu = time.process_time()
        output = pipeline({"waveform": samples, "sample_rate": rate})
        elapsed = time.perf_counter() - wall
        cpu_elapsed = time.process_time() - cpu
        annotation = output.speaker_diarization
        segments = [
            {"start": turn.start + offset, "end": turn.end + offset, "speaker": speaker}
            for turn, _, speaker in annotation.itertracks(yield_label=True)
        ]
        return {"processing_seconds": elapsed, "cpu_seconds": cpu_elapsed, "segments": segments}

    duration = len(audio) / rate
    print("Running full recording on CPU…", flush=True)
    full = run(waveform)
    full["processing_per_audio"] = full["processing_seconds"] / duration
    chunks = []
    worker_available = 0.0
    size = max(1, round(args.chunk_seconds * rate))
    for start in range(0, len(audio), size):
        end = min(start + size, len(audio))
        ready = end / rate
        print(f"Running chunk {start / rate:.1f}–{ready:.1f}s…", flush=True)
        result = run(waveform[:, start:end], start / rate)
        # A serial worker receives a chunk when its audio has finished arriving.
        queue = max(0.0, worker_available - ready)
        worker_available = max(worker_available, ready) + result["processing_seconds"]
        result.update({"start": start / rate, "end": ready,
                       "simulated_queue_seconds": queue,
                       "simulated_label_delay_from_chunk_end": worker_available - ready})
        chunks.append(result)
    print("Repeating full recording with warmed model…", flush=True)
    warm_full = run(waveform)
    warm_full["processing_per_audio"] = warm_full["processing_seconds"] / duration
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    report = {
        "model": args.model, "pyannote_audio_version": importlib.metadata.version("pyannote.audio"),
        "platform": platform.platform(), "machine": platform.machine(), "device": "cpu",
        "threads": args.threads, "audio_seconds": duration, "model_load_seconds": load_seconds,
        "peak_process_rss_mib": peak / (1024**2 if sys.platform == "darwin" else 1024),
        "full_recording": full, "warm_full_recording": warm_full, "chunks": chunks,
        "limitations": [
            "Chunk speaker IDs are independent; no cross-chunk identity matching is implemented.",
            "Queue timing is simulated from sequential measured inference, not live playback.",
            "Full recording runs first; chunk measurements benefit from warmed models.",
            "No transcription runs concurrently. This does not establish combined hardware requirements.",
            "No ground-truth speaker annotation: no diarization accuracy score is computed.",
        ],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(f"Saved {args.output}; processing/audio: {full['processing_per_audio']:.2f}×; peak RAM: {report['peak_process_rss_mib']:.0f} MiB")


if __name__ == "__main__":
    main()

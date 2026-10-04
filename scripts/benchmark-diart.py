#!/usr/bin/env python3
"""Run CPU Diart over annotated WAV clips; file replay measures throughput, not live latency."""
import os
for name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
    os.environ[name] = "2"
os.environ["PYANNOTE_METRICS_ENABLED"] = "0"
import argparse
import json
from pathlib import Path
import resource
import time
import torch
from diart import SpeakerDiarization, SpeakerDiarizationConfig
from diart.sources import FileAudioSource
from diart.inference import StreamingInference

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("directory", type=Path)
args = parser.parse_args()
torch.set_num_threads(2)
torch.set_num_interop_threads(1)
for item in json.loads((args.directory / "manifest.json").read_text()):
    name = item["id"]
    config = SpeakerDiarizationConfig(device=torch.device("cpu"), latency=2, step=0.5)
    load = time.perf_counter()
    pipeline = SpeakerDiarization(config)
    load = time.perf_counter() - load
    source = FileAudioSource(args.directory / f"{name}.wav", 16000, padding=(0, 2))
    inference = StreamingInference(pipeline, source, do_plot=False, show_progress=False)
    started = time.perf_counter()
    result = inference()
    elapsed = time.perf_counter() - started
    with (args.directory / f"{name}.diart.rttm").open("w") as handle:
        result.write_rttm(handle)
    report = dict(engine="diart", device="cpu", threads=2, configured_latency_seconds=2,
                  step_seconds=0.5, load_seconds=load, processing_seconds=elapsed,
                  audio_seconds=item["duration"], peak_process_rss_mib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024**2,
                  segments=[dict(start=t.start,end=t.end,speaker=s) for t,_,s in result.itertracks(yield_label=True)])
    (args.directory / f"{name}.diart.json").write_text(json.dumps(report, indent=2))
    print(f"{name}: {elapsed:.2f}s for {item['duration']}s audio", flush=True)

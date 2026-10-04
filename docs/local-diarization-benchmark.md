# Local speaker diarization experiment

This standalone benchmark tests pyannote Community-1 on CPU. It does not change
Callside's live transcription or speaker attribution settings.

## Setup

```sh
uv venv --python 3.11 .local/diarization-venv
uv pip install --python .local/diarization-venv/bin/python 'pyannote.audio>=4,<5' soundfile
```

Accept the model's access conditions yourself at
<https://huggingface.co/pyannote/speaker-diarization-community-1>, then authenticate:

```sh
.local/diarization-venv/bin/hf auth login
```

Use a read-access token; never commit it. The initial download requires internet
access. Inference runs locally. Pyannote telemetry is disabled by the benchmark.

## Run

Supply a 16 kHz WAV with multiple speakers. Convert other formats with ffmpeg:

```sh
ffmpeg -i conversation.mp4 -ar 16000 -ac 1 .local/diarization-input.wav
.local/diarization-venv/bin/python scripts/benchmark-diarization.py \
  .local/diarization-input.wav --threads 2 --chunk-seconds 12 \
  --output .local/diarization-report.json
```

The report contains full-recording speaker segments, independent chunk segments,
model loading time, processing time, CPU time, peak process memory, and simulated
queue delay. A processing/audio ratio below 1 means faster than audio duration
for that run, not a guarantee of live performance. Chunk IDs are not persistent
identities. Review missed turns, speaker merges/splits, and overlap by listening;
do not infer attribution quality from transcription word error rate.

Before choosing production defaults, also measure concurrent Whisper/Cohere
transcription, cold starts, longer meetings, and weaker CPUs. Do not hold up answer
suggestions while speaker attribution is pending: retain confirmed historical
labels and mark recent unattributed speech explicitly. Inferred identities must
not be presented as confirmed diarization.

Diart is a possible follow-up streaming experiment. It is a streaming pipeline,
using pyannote models by default, rather than simply a separate lightweight model.
Its model access and dependency requirements should be evaluated separately.

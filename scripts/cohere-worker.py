#!/usr/bin/env python3
"""Private stdio worker. Audio stays in memory and model loading is offline."""

import base64
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import time
import wave

# Set these before importing Hugging Face/MLX. Runtime must not download anything.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["DO_NOT_TRACK"] = "1"

LANGUAGES = {"ar", "de", "el", "en", "es", "fr", "it", "ja", "ko", "nl", "pl", "pt", "vi", "zh"}
MAX_AUDIO_BYTES = 1_000_000
MAX_LINE_BYTES = 1_400_000


def offline_guard(event, args):
    if event in {"socket.connect", "socket.bind", "socket.getaddrinfo"}:
        raise RuntimeError("Network access is disabled in the local transcription worker.")


def reply(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def main():
    sys.addaudithook(offline_guard)
    model_path = Path(sys.argv[1]).resolve(strict=True)
    if not model_path.is_dir():
        raise ValueError("A local model directory is required.")
    # Libraries may print diagnostics; stdout belongs exclusively to our protocol.
    with contextlib.redirect_stdout(sys.stderr):
        import mlx.core as mx
        import numpy as np
        from mlx_audio.stt import load

        model = load(model_path, strict=True)
        mx.eval(model.parameters())
    reply({"ready": True})

    while True:
        line = sys.stdin.buffer.readline(MAX_LINE_BYTES + 1)
        if not line:
            return
        if len(line) > MAX_LINE_BYTES or not line.endswith(b"\n"):
            raise ValueError("Invalid worker request size.")
        request_id = None
        try:
            request = json.loads(line)
            request_id = request["id"]
            if not isinstance(request_id, int):
                raise ValueError("Invalid request ID.")
            language = request["language"]
            if language not in LANGUAGES:
                raise ValueError("Select one of Cohere's supported languages.")
            raw = base64.b64decode(request["audio"], validate=True)
            if len(raw) > MAX_AUDIO_BYTES:
                raise ValueError("Audio must be at most 30 seconds.")
            with wave.open(io.BytesIO(raw), "rb") as wav:
                if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getcomptype()) != (1, 2, 16000, "NONE"):
                    raise ValueError("Audio must be mono 16 kHz PCM16 WAV.")
                if not 0 < wav.getnframes() <= 480_000:
                    raise ValueError("Audio must be between 0 and 30 seconds.")
                samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
            started = time.perf_counter()
            mx.reset_peak_memory()
            with contextlib.redirect_stdout(sys.stderr):
                result = model.generate(samples, language=language, sample_rate=16000, max_tokens=256, punctuation=True, verbose=False)
                mx.synchronize()
            text = result.text.strip()
            if len(text) > 16_000:
                raise RuntimeError("Local Cohere returned too much text.")
            reply({"id": request_id, "text": text, "processingMs": round((time.perf_counter() - started) * 1000), "peakMemoryBytes": mx.get_peak_memory()})
        except (ValueError, KeyError, TypeError, wave.Error):
            reply({"id": request_id, "error": "Invalid audio or language. Use mono 16 kHz PCM16 WAV up to 30 seconds and a supported language."})
        except Exception:
            # Never print audio/transcripts or library exception bodies into logs.
            reply({"id": request_id, "error": "Local Cohere could not transcribe this chunk. Stop and retry."})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Startup diagnostics contain no call audio; provide an actionable class only.
        sys.stderr.write(f"Cohere worker failed to start ({type(error).__name__}). Run npm run local:setup.\n")
        sys.exit(1)

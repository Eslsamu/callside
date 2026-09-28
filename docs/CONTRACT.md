# Internal API contract

All runtime HTTP routes share the UI origin on a loopback server. GET /api/bootstrap returns Bootstrap (token per server process, hasApiKey, suggested models). Other API requests need X-Callside-Token. POST /api/key {apiKey} stores a key in process memory only, responds {hasApiKey}. Environment key also supported. No provider key returned to renderer.

POST /api/answer takes AnswerRequest and streams SSE data: JSON AnswerEvent. Abort cancels provider. mode:auto uses a WAIT sentinel hidden from UI when model judges no intervention. demo:true provides deterministic, clearly marked local fixture responses without network.

WebSocket /api/realtime?token=...&source=mic|system authenticates token plus exact same-origin Origin. First client frame {type:'configure',model,language,prompt}. Server opens wss://api.openai.com/v1/realtime?intent=transcription, sends GA session.update with 24kHz PCM and turn_detection:null, waits for session.updated, then sends {type:'ready'}. Client then sends input_audio_buffer.append (base64 PCM16), input_audio_buffer.commit. Standard OpenAI transcription delta/completed/error/buffer.committed events forwarded. Session errors close the stream and are surfaced. No silent reconnection/lost audio.

POST /api/diarize accepts JSON {audio:base64 WAV, source, chunkId, timestamp, language}. Returns {entries:TranscriptEntry[]}, with timestamp milliseconds epoch at chunk start plus offset. Speaker IDs MUST be source + chunk ID + returned speaker label, since independent blocks cannot guarantee identity across chunks. UI clearly shows speaker recognition is per block.

src/audio/capture.ts exports async startCapture(settings:Settings, token:string, callbacks:CaptureCallbacks):Promise<CaptureHandle>. Calls native/browser getDisplayMedia for system source and getUserMedia for mic. Separate sources, AudioWorklet PCM16 24kHz client VAD. Realtime and diarized modes selectable. stop() flushes final speech, cancels tracks, drains pending transcriptions boundedly.

desktop/main.cjs boots built server via exported startServer({port:0,production:true}) -> {url,close}. Loads url in sandboxed window. Preload exposes window.callsideDesktop {onAnswer(callback):()=>void, setAlwaysOnTop(boolean):Promise<void>, platform:string}. Global CommandOrControl+Shift+Space sends callside:answer. Package scripts own build.

# Callside

A small, local call copilot. See what is being said, ask a question, or press one key for a response you can use in the conversation.

Callside listens to your microphone and the call audio you choose to share. OpenAI transcribes the audio and streams suggestions into a separate panel. You control the model, instructions, background context, and when help appears. The interface and repository documentation are in English.

![Callside displaying a clearly marked demo transcript and a suggested response](docs/assets/callside-demo.png)

## Try local transcription without an API key

Run `npm run local:test` for a microphone test with local Whisper, live drafts, and approximate latency measurements. See [the setup and measurement guide](docs/local-transcription-test.md). The first launch downloads a model; speech processing stays on your computer.

## What it does

- Live transcript with separate labels for your microphone and the other side of the call.
- Background speaker attribution for the call channel while live text and suggestions continue.
- A response button, typed questions, and **F8** while Callside has focus.
- Desktop shortcuts **F8** and **⌘⇧Space** on macOS or **Ctrl+Shift+Space** on Windows/Linux, which also work while the desktop app is in the background when the OS allows registration.
- Automatic hints: give the assistant a rule such as “suggest an answer whenever the customer asks a question.” The model can choose to stay quiet.
- Configurable answer model, prompts, language, source labels, and meeting context.
- JSON and Markdown exports. Session contents stay in memory until you export them.
- A clearly marked demo that works without a microphone or API key.

## Run it

Use **Node.js 22.12 or later** and npm. Clone or download this repository, then run:

```sh
npm ci
npm run dev
```

Open the local address printed in the terminal. Choose the demo to try the complete transcript and suggestion flow without an account.

For a real call, enter an [OpenAI Platform API key](https://platform.openai.com/api-keys) in the app settings. The key stays in the local server's memory for that process. Alternatively, copy `.env.example` to `.env` and set `OPENAI_API_KEY` there. `.env` is ignored by Git. Restart the server after changing environment variables.

To use the desktop window and global shortcut:

```sh
npm run desktop
```

To run the production web build:

```sh
npm run build
npm start
```

### Quick start

1. Run `npm ci` and `npm run dev`, then open the local address shown.
2. Select **Try demo**. For real calls, add an OpenAI API key in **Settings**.
   In the desktop app, leave **Remember API key on this device** checked and click **Save API key** to reuse it after restarting. **Remove API key** clears the saved key and the current session key. Browser users can set `OPENAI_API_KEY` in a local `.env` file.
3. Choose your model, prompts, context, microphone, and call audio.
4. Let everyone know about transcription, then start the call and grant audio permissions.
5. Press **F8**, click **Suggest answer**, or type a question. Enable **Automatic hints** for prompt-controlled assistance.
6. End the call and export the session as JSON or Markdown if needed.

## ChatGPT subscription or API key?

This version uses a **Platform API key**. It does not log into ChatGPT, reuse browser cookies, or read Codex credentials. ChatGPT sign-in is available for supported OpenAI products; OpenAI's authentication documentation directs general API calls to Platform API keys, with API usage billed through the Platform account. A ChatGPT subscription is therefore not configured as payment for Callside's transcription or Responses requests. See the [official OpenAI authentication documentation](https://learn.chatgpt.com/docs/auth#openai-authentication).

The defaults are `gpt-live-transcribe` for live transcription, `gpt-4o-transcribe-diarize` for the diarization mode, and `gpt-6-luna` for answers. Access depends on your API project. Answer models are restricted to GPT-6 Luna, Sol, and Astra. Reasoning strength is configurable: None, Low, Medium, High, Extra high, or Maximum; Astra starts at Low. Fast mode requests priority processing where available at 2× standard token rates. It is off by default. The output budget includes both reasoning and visible answer tokens. Check [OpenAI API pricing](https://developers.openai.com/api/docs/pricing) and your project limits before a long call. Automatic mode can make repeated model requests, including requests whose result is silence.

## Choosing an audio mode

| Mode                                        | Speaker labels                                                                                                    | Tradeoff                                                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Live + background speakers (default)        | Live text first, then Speaker 1–4 labels linked using voice reference clips. Your microphone keeps its own label. | Suggestions do not wait for attribution. Adds a paid diarization pass over call audio.                     |
| Live transcription, background speakers off | Microphone and system audio have independent labels, such as “Me” and “Other speaker.”                            | Useful for one-to-one calls. Everyone on system audio shares its label.                                    |
| Speaker diarization                         | OpenAI distinguishes speakers within each short audio block.                                                      | Adds block buffering and request latency. Speaker IDs are scoped to a block and can change between blocks. |

In **Fast: separate live channels**, **Identify call speakers in the background** is enabled by default. The same captured call audio is also analyzed by `gpt-4o-transcribe-diarize` in 12-second batches with up to two seconds of overlap. Existing saved batch lengths are retained. Text and suggestions appear before labels are available. Background results update or split existing transcript turns while preserving the original live wording; they do not append a second transcript or trigger an automatic hint again for the same live turn. Corrected labels are used by later answers and exports.

Clean, non-overlapping voice clips of 2–6 seconds are kept in capture memory for up to four remote speakers and sent as OpenAI known-speaker references in later requests. This links generic Speaker 1–4 labels between batches, but is not a guarantee of identity. Short or overlapping voices without a clean clip, and additional voices beyond the reference limit, remain visibly scoped to their batch. Reference clips are cleared at the end of capture and excluded from templates and exports. Callside does not infer real names or enroll permanent voiceprints.

The status line shows processing time after a result, excluding the time spent collecting the batch. When background analysis cannot keep up, it skips older pending batches. If it fails, it pauses attribution while live transcription continues. Some turns may remain unattributed. End call drains final work for at most ten seconds for background attribution. Disable the background checkbox to avoid its extra API usage; the overlap also adds a small amount of repeated audio analysis.

Overlapping speech, echo, and poor audio can reduce accuracy. Use headphones to avoid feeding the remote speaker back through your microphone. Speaker attribution on the call channel does not remove acoustic microphone bleed.

**Filter microphone echo duplicates** is enabled by default. When near-identical speech starts on both channels within 750 ms, the transcript keeps the finalized call-channel copy. Numbers and negations must agree; short replies and later repetitions remain. Blank transcript turns are omitted. This text filter does not prevent duplicate audio from being transcribed or reduce transcription billing. Disable it to compare the original channel entries in the current session. It is a heuristic and can misclassify simultaneous repetition; headphones still give the cleanest separation.

In browser mode, choose a shareable tab or surface and enable its audio-sharing option. Support for full system audio depends on the browser and OS. The desktop app provides an additional Electron capture path. If your call's audio cannot be shared, use **Load audio inputs** and select a virtual loopback device under **Call audio source**. This keeps remote audio on the call channel used by automatic hints. See [audio setup and troubleshooting](docs/TROUBLESHOOTING.md).

## Make suggestions useful

Put stable instructions in the answer prompt: desired language, tone, response length, and what the assistant must never invent. Put call-specific facts in the context field, such as the agenda, product facts, prices, and what you are allowed to promise.

For automatic mode, describe **when** to speak up. For example:

> Suggest a short answer when the customer asks a direct question or raises an objection. Stay quiet during small talk and while I am speaking. If facts are missing, suggest one precise follow-up question.

Automatic mode evaluates finalized transcript updates, observes a cooldown, and includes previous suggestions to reduce repetition. It may miss an opportunity or intervene at the wrong moment. Manual triggering remains available. Suggestions are text only; Callside does not speak into the call or send messages to participants.

## Privacy and boundaries

The app and its server run locally. Selected audio and relevant transcript/context are sent to OpenAI when you use an API session. The separate local Whisper microphone test processes audio entirely on your computer. Demo mode uses local fixtures.

- API keys are held in server memory and are not returned to the renderer. Desktop users can explicitly remember a key using OS-backed encryption in app data outside the repository. Browser/session-only keys are not persisted by the UI.
- The server listens on loopback. Keep it local; this is not a multi-user hosted service.
- Transcripts and suggestions are not automatically written to disk. Exported files contain the conversation, so choose where to save them carefully.
- **Save template** explicitly saves settings, prompts, and context in browser storage on this device. It does not save API keys or transcripts. **Reset** removes that saved template. Settings may contain confidential context, so review them before saving.
- Stop capture when the call ends. Obtain the participants' agreement before transmitting their audio.

See [security](SECURITY.md) for the threat model and reporting guidance.

## Development

```sh
npm ci
npx playwright install chromium
npm run check
```

`check` builds and type-checks the app, runs unit/integration tests, and runs the browser tests. Browser tests use the explicit demo and mocked inputs. They do not make paid OpenAI calls or use a real microphone. They cannot verify your operating system's permissions, real call routing, real model access, or production latency. A real-audio acceptance checklist is in [testing](docs/TESTING.md).

`npm run test:desktop` separately checks the production Electron shell, preload bridge, and IPC in a hidden window with an isolated temporary profile. It uses demo data, sends the answer shortcut's IPC event, and skips actual global-key registration and real audio capture.

```sh
npm run desktop:pack   # unpacked app for the current platform
npm run desktop:dist   # installer/archive for the current platform
```

Build distributable desktop packages on the target OS. Public macOS and Windows distribution also requires your own signing/notarization setup. No signing credentials or prebuilt signed installers are included.

See [architecture and provider extensions](docs/ARCHITECTURE.md), the [API contract](docs/CONTRACT.md), and [contributing](CONTRIBUTING.md).

## License

[MIT](LICENSE). Bundled fonts and interface icons retain their own licenses; see [asset attribution](docs/assets/README.md). OpenAI and any other services you connect have their own terms and usage charges. Callside is an independent project.

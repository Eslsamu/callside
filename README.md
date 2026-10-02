# Callside

**Live AI assistance for meetings, sales calls, interviews, and workshops. No typing required during the conversation.**

Callside is an MIT-licensed desktop call copilot. It transcribes microphone and call audio, uses your task instructions and reference material, and streams contextual suggestions. Press **F8**, click **Help now**, or enable **Automatic hints** so the model decides when to offer help. Questions and commands are optional.

It is a free, open-source alternative to Cluely for live conversation assistance. See the [comparison section](#an-alternative-to-cluely-final-round-ai-and-lockedin-ai) for differences and limitations.

**The software is free. OpenAI API usage is paid separately through your own API account.** There is no Callside subscription, license fee, or account requirement. Live cloud transcription and background speaker attribution incur API charges. Suggestions can use your ChatGPT plan or API credit. The built-in demo is free and needs no API key.

[Quick start](#quick-start) · [Compare alternatives](docs/ALTERNATIVES.md) · [Contributing](CONTRIBUTING.md) · [Roadmap](docs/ROADMAP.md) · [MIT license](LICENSE)

![Callside demo showing a live transcript, contextual suggestion, and the Help now keyboard shortcut](docs/assets/callside-demo.png)

## How it works without typing

1. **Before the call:** choose a task and model, add course notes, product facts, or other reference material, and select audio sources.
2. **During the call:** Callside transcribes the conversation. Press **F8** or **Command/Ctrl+Shift+Space** for a contextual response, explanation, next step, or other configured output. You do not have to retype what someone said.
3. **For automatic help:** enable **Automatic hints** and set a rule, such as “When a participant needs clarification, suggest a short explanation using the course notes.” Checks follow finalized speech segments and can return no suggestion.

The model infers the current need from the available transcript and instructions. Automatic timing and answer quality are model-dependent. The desktop shortcuts work outside the Callside window when the operating system allows registration; the browser shortcut requires focus.

## An alternative to Cluely, Final Round AI, and LockedIn AI

If you are looking for a **free, open-source Cluely alternative**, Callside provides live transcription and contextual assistance with source code you can modify and an API key you control. It also covers the live conversation-assistance use case of tools such as **Final Round AI** and **LockedIn AI**, while allowing tasks for teaching, customer support, and sales.

The [comparison guide](docs/ALTERNATIVES.md) links to those products' official documentation and explains the differences. Callside is an independent project; it does not claim feature parity, guaranteed latency, screen understanding, or invisibility during screen sharing.

## Project status

Early-stage software. The repository is initially private while being prepared for public release; the code is MIT-licensed. macOS Apple Silicon has been used for desktop testing. Windows and Linux packaging targets exist, but their capture paths need broader real-device testing. Build from source with the commands below; signed installers are not currently provided.

## What it does

- Live transcript with separate labels for your microphone and the other side of the call.
- Background speaker attribution for the call channel while live text and suggestions continue.
- **Help now** and **F8** use the current conversation without a typed question; an optional command field is available.
- Desktop shortcuts **F8** and **⌘⇧Space** on macOS or **Ctrl+Shift+Space** on Windows/Linux, which also work while the desktop app is in the background when the OS allows registration.
- Automatic hints: give the assistant a rule such as “suggest an answer whenever the customer asks a question.” The model can choose to stay quiet.
- Configurable answer model, prompts, language, source labels, and meeting context.
- JSON and Markdown exports. Session contents stay in memory until you export them.
- A clearly marked demo that works without a microphone or API key.

## Run it

Use **Node.js 22.12 or later** and npm. While the repository is private, you need GitHub access to clone it.

```sh
git clone https://github.com/Eslsamu/callside.git
cd callside
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
5. Press **F8** or click **Help now**; no typed command is needed. Enable **Automatic hints** for prompt-controlled assistance.
6. End the call and export the session as JSON or Markdown if needed.

## ChatGPT subscription or API key?

The desktop app supports **Continue with ChatGPT** for contextual suggestions using OpenAI's [official ChatGPT plan usage flow](https://developers.openai.com/siwc/token-sharing-open-source). There is no extra Callside subscription. Plan eligibility, available models, and usage limits are controlled by OpenAI. Transcription and speaker attribution still require an API key and incur API charges.

1. Open **Settings → Suggestion connection → Continue with ChatGPT**.
2. Complete sign-in and approve plan usage in your system browser, then return to Callside.
3. Select **ChatGPT subscription** and an available GPT-6 model. Click **Save template** to retain this billing choice and your task settings after restarting.
4. Keep your existing API key for audio. Use **Help now**, F8, or **Automatic hints** as before; no typing is required.

Credentials are encrypted using the OS key store and refreshed automatically. You can switch accounts, reconnect, sign out, and open ChatGPT usage settings. Tokens are never saved in templates or exports. Subscription errors **never fall back to API billing**. The browser-only version currently supports API keys only.

In subscription mode, custom output caps, priority/Fast mode, and explicit cache controls are omitted. Reasoning strength, reference material, streamed suggestions, and automatic triggers remain available. Account-specific GPT-6 model availability comes from OpenAI; a subscription does not guarantee access to every model. The built-in demo stays synthetic and does not test your subscription connection.

The defaults are `gpt-live-transcribe` for live transcription, `gpt-4o-transcribe-diarize` for the diarization mode, and `gpt-6-luna` for tasks. Access depends on your API project. Task models are restricted to GPT-6 Luna, GPT-6 Sol, GPT-6.1 Sol, and GPT-6 Astra. Reasoning strength is configurable: None, Low, Medium, High, Extra high, or Maximum; Astra and GPT-6.1 Sol start at Low. Fast mode requests priority processing where available at 2× standard token rates. It is off by default. The output budget includes both reasoning and visible answer tokens. Check [OpenAI API pricing](https://developers.openai.com/api/docs/pricing) and your project limits before a long call. Automatic mode can make repeated model requests, including requests whose result is silence.

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

## Configure a task and reference material

Put behavior in **Task instructions** and course notes, documentation, or other facts in **Reference material**. The application supports explanations, hints, corrections, summaries, and typed commands. Presets set the task, automatic rule, and trigger source. Your reference material stays in place. Exact old default prompts migrate to general task instructions; custom saved instructions and existing numeric output budgets are preserved.

Reference material supports up to **100,000 characters**. The UI shows the count and retains oversized pasted text, but blocks task requests until it is shortened. The entire reference material is included with every request. Conversation history is a separate rolling window: the newest 120 transcript entries, bounded to 24,000 text characters. Callside does not retain the full workshop history in each model request.

### Workshop setup

1. Open **Settings** and choose **Workshop** under **Task configuration**.
2. Paste the course notes into **Reference material**. Include section names, exercise identifiers, and official solutions where available.
3. Choose **GPT-6.1 Sol**, **Low** reasoning, and **Model default** under **Output token limit**. Fast mode is optional and costs more.
4. Click **Save template**, return to **Conversation**, and leave **Automatic hints** off for the first test.
5. Press **F8**, **Command/Ctrl+Shift+Space**, or **Help now** whenever you need help. The model infers the current topic and need from the conversation; typing is optional and hidden under **Specific command (optional)**.

Manual triggering can use partial transcript text and works with reference material before anyone has spoken. Workshop instructions choose a response, explanation, example, exercise step, correction, or transition from the ongoing discussion. They lead with a short passage the facilitator can say aloud and keep any source reference separate. If clarification is essential, they suggest a question to ask participants aloud. Exact saved v0.3.0 Workshop and General defaults upgrade automatically; edited prompts remain untouched.

For automatic assistance, select **Automatic trigger source**: **Other speakers (call audio)**, **Me (microphone)**, or **Either**. Workshop selects Either. The app checks the **Automatic mode prompt** after finalized segments from the selected audio source, with a cooldown and duplicate-turn suppression. These source choices describe audio channels; microphone bleed can still affect attribution. Checks that produce no result also consume API tokens. Automatic hints can miss opportunities or intervene at the wrong moment.

### Reference caching and output limits

Requests put stable application instructions, task instructions, and the automatic rule first, then the complete reference material in a separate data message with an explicit cache breakpoint. Mode instructions, recent transcript, previous results, and commands follow that boundary. The provider uses explicit caching with a 30-minute minimum TTL, so changing commands or switching manual/automatic mode preserves the earlier prefix. Cache reuse depends on provider behavior and unchanged settings/material; it is not guaranteed.

Session JSON exports include `requestUsage` for completed requests and intentional automatic skips when OpenAI reports usage. This records input, output, cached input, cache-write, and reasoning tokens where available. Failed or cancelled requests may incur usage that is not included. No document index, vector store, or embedding service is created. See [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

**Model default** omits the custom output token cap. A **Custom limit** bounds generated reasoning plus visible output, not input context. Existing request timeouts and stream-size safeguards still apply. Concision comes from the task instructions; the model is not asked to fill its budget. Results are text only: Callside does not speak into the call or send messages to participants.

## Privacy and boundaries

The app and its server run locally. Selected audio and relevant transcript/context are sent to OpenAI when you use an API session. The separate local Whisper microphone test processes audio entirely on your computer. Demo mode uses local fixtures.

- API keys are held in server memory and are not returned to the renderer. Desktop users can explicitly remember a key using OS-backed encryption in app data outside the repository. Browser/session-only keys are not persisted by the UI.
- The server listens on loopback. Keep it local; this is not a multi-user hosted service.
- Transcripts and suggestions are not automatically written to disk. Exported files contain the conversation, so choose where to save them carefully.
- **Save template** explicitly saves settings, prompts, and context on this device. Desktop templates use permanent app storage and survive restarts and release updates; browser mode uses browser storage. It does not save API keys or transcripts. **Reset** removes that saved template. Settings may contain confidential context, so review them before saving.
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

### Numbered releases

Desktop builds use the version in `package.json`. For example, version **0.3.2** is packaged into `release/v0.3.2/`. Installers and archives include the version, OS, and architecture in their filenames, such as `Callside-0.3.2-mac-arm64.dmg`.

After successful packaging, `release/Latest` points to that build folder. On an Apple Silicon Mac, open `release/Latest/mac-arm64/Callside.app` in Finder. The shortcut follows the most recently completed build; older version folders remain available. Early builds in folders such as `live-help` or `workshop` are legacy copies.

For the next release, increment the version before packaging:

```sh
npm version patch --no-git-tag-version  # 0.3.2 -> 0.3.3; use minor for a feature release
npm run desktop:pack
```

This updates both package files and creates a new numbered build folder. Rebuilding the same version replaces that version's packaged app. See [release notes](CHANGELOG.md) for the changes in each version.

Build distributable desktop packages on the target OS. Public macOS and Windows distribution also requires your own signing/notarization setup. No signing credentials or prebuilt signed installers are included.

### Optional local transcription experiment

Run `npm run local:test` for a separate microphone test with local Whisper and approximate latency measurements. See [the local setup guide](docs/local-transcription-test.md). It downloads a model on first use and processes speech locally. This experiment does not replace the full app's API-based call assistance.

## Questions and contributions

Use [Issues](https://github.com/Eslsamu/callside/issues) for reproducible bugs and feature proposals, and [Discussions](https://github.com/Eslsamu/callside/discussions) for setup questions and workflow ideas. New contributors can start with documentation, synthetic tests, or platform testing; no paid API account is required for the automated checks. See [CONTRIBUTING.md](CONTRIBUTING.md) and [the roadmap](docs/ROADMAP.md). Report security issues through [SECURITY.md](SECURITY.md).

See [architecture and provider extensions](docs/ARCHITECTURE.md), the [API contract](docs/CONTRACT.md), and [contributing](CONTRIBUTING.md).

## License

[MIT](LICENSE). Bundled fonts and interface icons retain their own licenses; see [asset attribution](docs/assets/README.md). OpenAI and any other services you connect have their own terms and usage charges. Callside is an independent project.

## Compare local transcription models

A separate [Cohere-versus-Whisper test](docs/local-comparison.md) records once and replays the same audio through both local models, with transcript, latency, and optional word-error comparisons. On Apple Silicon, run `npm run local:setup` followed by `npm run local:compare`. It uses no API credit and does not change the main app's transcription provider.

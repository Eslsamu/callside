# Audio setup and troubleshooting

Start with demo mode to confirm the interface and local server work. Then test a short call with a willing participant before using Callside for a longer conversation. Headphones reduce echo and duplicate transcript entries.

## Browser mode

Use a browser that supports microphone capture, `getDisplayMedia`, and AudioWorklet on a loopback address. Chromium-based browsers are the primary development target. Other browsers can offer fewer system audio options.

For a browser-based call, choose its tab in the sharing picker and enable **Share tab audio** or the equivalent option. A screen or window share does not necessarily include audio. An audio meter moving in the call application does not prove the shared stream includes sound.

Full desktop audio capture varies by browser and OS. If the selected surface supplies no audio track, Callside reports the problem. Choose a supported tab, try the desktop app, or load the audio inputs in settings and select a virtual loopback device under **Call audio source**. Microphone-only mode is also available.

## macOS

1. Allow microphone access for the browser or Callside when prompted.
2. Review the app's capture permission in **System Settings → Privacy & Security**. Depending on the macOS version, this appears under Screen Recording or Screen & System Audio Recording.
3. Quit and reopen the relevant application after changing OS permissions if requested by macOS.
4. Retry a short recording and check both audio-source indicators.

The desktop packaging configuration includes microphone, audio capture, and screen capture usage descriptions. A development Electron process and a packaged Callside app can have different permission entries. Granting permission to one does not prove the other has permission.

For native call apps such as WhatsApp, enable both **Transcribe microphone** and **Transcribe call audio**, and keep **Call audio source** set to **System / shared tab**. Open the packaged **Callside.app** directly in Finder for the first test, allow audio capture when macOS prompts, and check the **Other speaker** meter while the other person speaks. Keep the call app running when restarting Callside.

Electron's default CoreAudio capture path requires the terminal or IDE hosting a development launch to have its own audio usage description. Callside uses Electron's documented Screen & System Audio Recording compatibility path for development launches; packaged apps retain the default path. See [Electron's macOS capture caveats](https://www.electronjs.org/docs/latest/api/desktop-capturer#macos-versions-142-or-higher). A stream with no live audio track fails before any API connection is opened; Callside does not silently continue with only the microphone.

Some combinations of Electron, macOS, and device routing do not provide system audio through the selected capture path. For those systems, route the call through a loopback device and choose that device in Callside. If both you and the other participant are mixed into one input, use diarization and remember that speaker IDs are per block. Configure routing yourself; Callside does not install audio drivers or change the system's default devices.

No signing identity is included in the repository. Electron Builder can automatically discover an identity on your Mac. To skip that discovery for a local test, run `CSC_IDENTITY_AUTO_DISCOVERY=false npm run desktop:pack`. A maintainer distributing public macOS builds should configure code signing and notarization. Local package generation alone does not establish that every installed user's privacy permissions or audio routing will work.

## Windows

Allow microphone access for desktop applications in the Windows privacy settings. In the capture picker, choose a source that actually shares audio. Browser tab audio is often the simplest path for a browser call. For a native call application, try the Electron desktop capture path and confirm that its system audio meter moves.

If system capture is unavailable, use a loopback input device or microphone-only capture. Check the selected device after changing headsets; devices can disappear and reappear with a different identifier.

## Linux

System audio support depends on the browser/Electron build, desktop environment, display server, portal implementation, and PipeWire/PulseAudio configuration. Screen sharing can succeed while system audio is absent.

Prefer shared browser-tab audio where available. Otherwise, expose a monitor/loopback source through your audio routing tools and select it under **Call audio source**, keeping your physical microphone on its own channel. The application does not install or configure a PipeWire graph. On Wayland, global shortcuts may also be restricted by the desktop environment; use the visible response button or focused **F8** shortcut if registration fails.

## Common issues

| Symptom                                        | What to check                                                                                                                                            |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Demo works; a real call fails immediately      | Add a valid Platform API key and verify the API project has model access and billing configured.                                                         |
| My voice appears but the other side is missing | Confirm system audio is selected and the chosen surface contains an audio track. Try sharing the call's browser tab with audio enabled.                  |
| Remote speech appears under both labels        | Use headphones and avoid routing call output back into the physical microphone.                                                                          |
| The transcript is several seconds behind       | Check network quality and speech boundaries. Diarization must wait for a whole block before sending it. Use live mode for quicker one-to-one help.       |
| The same person receives a new speaker ID      | This is expected between independent diarization blocks. Stable voice identity across the call is not implemented.                                       |
| No automatic hint appears                      | Confirm automatic mode is on, a new finalized transcript turn exists, and the cooldown has passed. The configured rule may tell the model to stay quiet. |
| Hints repeat too often                         | Tighten the automatic rule or increase the cooldown. Each evaluation can incur API usage even when no hint is shown.                                     |
| An answer invents a product detail             | Add verified facts and explicit limits to the context/prompt. Treat suggestions as drafts you review before speaking.                                    |
| F8 does nothing in the call application        | In browser mode, F8 requires Callside focus. The desktop app attempts to register both F8 and `CommandOrControl+Shift+Space` globally.                   |
| The desktop shortcut does nothing              | Another app or the desktop environment may own the combination. Use the button/F8 and inspect the desktop startup message for registration errors.       |
| Model access, quota, or rate-limit error       | Check the selected model and API project's limits. Callside displays provider failures rather than supplying a fake live response.                       |
| Local port is occupied                         | Stop the older Callside process or set `PORT` to a free port. The desktop shell chooses a free port itself.                                              |
| Unsaved transcript disappeared                 | Session data is held in memory. Export before refreshing, closing the window, or starting a new session.                                                 |

## Reporting a problem

Include the OS version, browser or desktop mode, selected capture mode, which source failed, and the visible error. Use a synthetic reproduction and redact private content. Do not attach API keys, `.env`, credentials, or recordings of people who did not agree to share them.

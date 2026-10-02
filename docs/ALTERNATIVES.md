# Callside vs. Cluely, Final Round AI, and LockedIn AI

Callside is a free, MIT-licensed, open-source alternative for live conversation assistance. The application has no subscription fee. You supply an OpenAI API key and pay the provider for transcription and generated suggestions.

## What these tools have in common

They help during a conversation using its context. This is a comparison of relevant workflows, not a feature-parity claim or a ranking. Product descriptions below were checked against official sources on **October 2, 2026**; features and plans can change.

| Product                                               | Relevant workflow in its official documentation                                                       | When to consider Callside                                                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [Cluely](https://cluely.com/)                         | Live meeting assistance, shortcut-triggered answers, and meeting notes.                               | You want editable source code, your own API account, and configurable tasks for live calls.                                |
| [Final Round AI](https://www.finalroundai.com/)       | Interview preparation, live Interview CoPilot assistance, practice interviews, and debriefs.          | You want a general conversation assistant with interview prompts, without needing a dedicated interview preparation suite. |
| [LockedIn AI](https://docs.lockedinai.com/docs/using) | Interview and professional-meeting sessions, custom prompts, model selection, and keyboard shortcuts. | You want a small local application whose prompts, provider integration, and behavior you can change yourself.              |

Other products also offer shortcuts and automatic assistance. Callside's no-typing workflow is a feature of this project, not a claim that competitors require typing.

## What Callside provides

- **No typing during the call:** F8, the global shortcut, or Help now runs the configured task using available conversation context.
- **Automatic hints:** a configurable prompt determines whether new speech calls for help. No typed command is needed.
- **General tasks:** explanations, speaking suggestions, teaching hints, troubleshooting steps, or summaries, depending on your instructions.
- **Reference material:** paste up to 100,000 characters of course notes, product facts, or documentation before the call.
- **Local desktop UI:** microphone and system-audio capture, a live transcript, background speaker attribution, and JSON/Markdown exports.
- **MIT-licensed source:** run, inspect, modify, and redistribute the software under the license.

See the [README](../README.md) for setup and [architecture](ARCHITECTURE.md) for implementation boundaries.

## Costs and limitations

The software and synthetic demo are free. Real transcription, optional background speaker attribution, and task generation incur OpenAI API charges. Automatic checks can cost money even if the model decides not to show a suggestion. There is no fixed all-inclusive per-meeting price.

The UI and server run locally, but real API sessions send selected audio and relevant text to OpenAI. The full assistant is not offline. The separate local Whisper microphone experiment is not a complete substitute for the call assistant.

Callside does not currently provide screen understanding, document uploads or search, calendar integrations, a hosted meeting archive, or built-in interview simulations. It does not hide its window from screen sharing. The pin button only keeps the window on top. Audio permissions, system capture, and global shortcuts vary by OS; Windows and Linux need broader real-device validation.

No guaranteed response latency or speaker-identification accuracy is claimed. The project does not benchmark itself as faster or more accurate than the products above. Follow the participants' agreement and the rules of the setting where you use assistance.

Callside is independent of Cluely, Final Round AI, and LockedIn AI. Product names identify the compared tools and do not imply affiliation or endorsement.

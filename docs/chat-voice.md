# Chat voice

Main chat uses cloud-generated speech with the approved Lain robo preset. The
legacy Kokoro controller, neural workers, model download consent and local preview
routes were removed in Milestone 5F.5. There is no local inference fallback.

See [cloud chat voice](cloud-chat-voice.md) for activation and manual replay,
[progressive cloud speech](progressive-cloud-speech.md) for streaming narration,
and [API usage protection](api-usage-protection.md) for persistent billing controls.

Voice is off on each visit. Local preferences remember volume and the prior
preference, never permission to autoplay or session credentials. Explicit activation
unlocks the AudioContext; only eligible live responses begin automatic narration.
Stop, new submissions, conversation switching, New Chat, disable and unmount cancel
queued/active work and reject stale audio. Text chat remains independent.

`cloud-chat-voice-controller.ts` and `use-chat-voice.ts` own the current lifecycle;
`voice-types.ts` supplies the controls' view type without importing an inference
engine. Shared Markdown segmentation, Refined DSP, PCM scheduling and analyser
utilities remain. `npm run test:cloud-voice` covers the controller and playback;
`npm run test:voice` verifies the retained reference DSP. Voice remains unavailable
in public production until the security milestone is approved.

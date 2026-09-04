# OpenClaw local media plugin

This package will register one native media-understanding provider for STT and
one native speech provider for TTS.

It will use OpenClaw's configured local-service lease mechanism instead of
starting or supervising workers itself. Channel behavior remains in OpenClaw:
Matrix voice notes are transcribed before the agent run, and
`tts.auto: "inbound"` adds speech only for audio-originated conversations.

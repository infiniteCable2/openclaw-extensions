# Local media contract v1

This directory owns the implementation-neutral contract between the native
OpenClaw plugin and local media services.

The first executable contract will define:

- separate liveness, readiness, and content-free status responses;
- bounded binary audio upload for transcription;
- bounded text input and binary audio output for synthesis;
- request correlation, deadlines, and cancellation;
- requested and observed compute backends;
- closed error codes for overload, timeout, cancellation, unavailable
  accelerator, unsupported media, and inference failure.

The contract will not contain Voicecore names, OpenClaw session identifiers,
Matrix identifiers, phone numbers, transcripts in diagnostics, or hardware
lease credentials.

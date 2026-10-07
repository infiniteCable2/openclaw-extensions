# Voiceassistant Gateway adapter

This plugin binds one exact, paired Pi node identity to one agent and feeds its
PCM into OpenClaw's existing Meeting STT/agent/TTS engine. There is no second
agent loop and no Voicecore runtime dependency. The Pi client lives in the
separate `openclaw-devices/voiceassistant` repository.

The first paired Pi/Meeting adapter is deployed and has passed an end-to-end
STT/TTS call. The wake-word, three-mode button, device-control and richer LED
candidate described here is **not selected for production yet**. The Pi's local
WebRTC AEC works as a frame processor, but its acoustic delay/full-duplex
performance still needs real-device calibration.

Configuration binds `nodeId` (the SHA-256 device identity shown during
pairing) to `agentId` exactly. `transcriptionProvider`, `providers`,
`responseStreaming`, optional waiting audio and `agentProfiles[agentId]` use
the same shared Meeting engine concepts as Matrix RTC. The first setup should
keep `toolPolicy` at its default `safe-read-only`: pairing authenticates the
device, **not the human speaker**. Granting `owner` would expose write-capable
agent tools to anyone physically able to speak near the device and needs a
separate admission decision.

The node command is deliberately marked dangerous and requires an explicit
Gateway command allow grant. Its policy accepts only the configured node and
`deviceFamily=voiceassistant`, and forwards only the bounded media and device
actions. The `voiceassistant_device` tool is published only to the bound agent;
the Pi voice session adds **that tool only** to its otherwise safe-read-only
catalog. Restart and shutdown additionally require an authenticated owner turn,
explicit confirmation and the narrow Pi authorization rule; an unauthenticated
speaker at the device cannot request them. No general shell access is granted. The candidate starts
muted; each short press cycles muted → wake-word → continuous → muted. Server
readiness holds the short listening window, then starts the bridge. Mute,
disconnect, bridge loss or the 30-minute maximum closes it. A Gateway restart
stops an orphan bridge instead of adopting stale audio. Continuous mode reopens
a lost session without requiring another button press. Wake-word mode returns
to local detection after its six-second inactivity window.

Example configuration shape (replace the placeholders; keep existing command
grants when adding the new one):

```json
{
  "gateway": { "nodes": { "commands": { "allow": ["voiceassistant.audio"] } } },
  "plugins": {
    "entries": {
      "voiceassistant": {
        "enabled": true,
        "config": {
          "nodeId": "64-character paired device ID",
          "agentId": "steffen",
          "transcriptionProvider": "your existing realtime STT provider",
          "responseStreaming": "sentence",
          "agentProfiles": {
            "steffen": {
              "agentThinkingLevel": "off",
              "speakCommentary": true,
              "toolPolicy": "safe-read-only"
            }
          }
        }
      }
    }
  }
}
```

The sample is illustrative, not a drop-in replacement for the existing
OpenClaw config; merge it with the current Gateway, provider and agent
settings. Before pairing, determine a certificate-valid Gateway URL reachable
from the Pi and test its TLS chain. Do not expose a new public Gateway port
merely to make this sample work.

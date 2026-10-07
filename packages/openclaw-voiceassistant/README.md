# Voiceassistant Gateway adapter

This plugin binds one exact, paired Pi node identity to one agent and feeds its
PCM into OpenClaw's existing Meeting STT/agent/TTS engine. There is no second
agent loop and no Voicecore runtime dependency. The Pi client lives in the
separate `openclaw-devices/voiceassistant` repository.

The plugin is **not deployed**. It needs a nonproduction Gateway pairing test,
an end-to-end STT/TTS call and an audited production cutover. The Pi's local
WebRTC AEC is working as a frame processor, but its acoustic delay/full-duplex
performance is not yet calibrated; the adapter therefore does not advertise
full-duplex barge-in.

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
`deviceFamily=voiceassistant`, and forwards only the bounded media actions.
The device starts muted; a double button press opens one session. Server
readiness holds the short listening window, then starts the bridge. Mute,
disconnect, bridge loss or the 30-minute maximum closes it. A Gateway restart
stops an orphan bridge instead of adopting stale audio.

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
          "agentId": "example_owner",
          "transcriptionProvider": "your existing realtime STT provider",
          "responseStreaming": "sentence",
          "agentProfiles": {
            "example_owner": {
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

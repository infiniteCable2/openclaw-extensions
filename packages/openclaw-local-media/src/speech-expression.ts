import type { SpeechProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";

type SpeechExpressionCapabilities = NonNullable<
  ReturnType<NonNullable<SpeechProviderPlugin["getExpressionCapabilities"]>>
>;

export const KITTEN_TTS2_MODEL_ID = "kitten-tts-2";

// Reviewed model metadata, not per-channel permission. Candidate installation
// must verify the running service's /v1/capabilities against this contract.
const KITTEN_TTS2_EXPRESSION: SpeechExpressionCapabilities = {
  emotions: [
    "angry",
    "contemplative",
    "excited",
    "joyful",
    "mundane",
    "nervous",
    "sad",
    "stern",
    "surprised",
    "tender",
  ],
  vocalEvents: ["gasp", "giggle", "growl", "gulp", "laugh", "pause", "scoff", "sigh", "sob", "um"],
  emphasis: true,
  whisper: false,
};

export function getLocalSpeechExpressionCapabilities(
  selectedModel: string,
): SpeechExpressionCapabilities | undefined {
  return selectedModel === KITTEN_TTS2_MODEL_ID ? KITTEN_TTS2_EXPRESSION : undefined;
}

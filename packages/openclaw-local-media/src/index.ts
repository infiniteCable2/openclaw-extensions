import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { LOCAL_MEDIA_PROVIDER_ID } from "./constants.js";
import { buildLocalMediaUnderstandingProvider } from "./media-provider.js";
import { buildLocalRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";
import { buildLocalMediaSpeechProvider } from "./speech-provider.js";

export default definePluginEntry({
  id: LOCAL_MEDIA_PROVIDER_ID,
  name: "Local Media",
  description: "Local speech-to-text and text-to-speech providers",
  register(api) {
    api.registerMediaUnderstandingProvider(
      buildLocalMediaUnderstandingProvider(api.runtime.llm.acquireLocalService),
    );
    api.registerRealtimeTranscriptionProvider(
      buildLocalRealtimeTranscriptionProvider(api.runtime.llm.acquireLocalService),
    );
    api.registerSpeechProvider(buildLocalMediaSpeechProvider());
  },
});

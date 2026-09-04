import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  transcribeOpenAiCompatibleAudio,
  type MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
import { DEFAULT_STT_MODEL, LOCAL_MEDIA_PROVIDER_ID } from "./constants.js";
import { requireLoopbackBaseUrl } from "./local-url.js";

type AcquireLocalService = OpenClawPluginApi["runtime"]["llm"]["acquireLocalService"];

export function buildLocalMediaUnderstandingProvider(
  acquireLocalService: AcquireLocalService,
): MediaUnderstandingProvider {
  return {
    id: LOCAL_MEDIA_PROVIDER_ID,
    capabilities: ["audio"],
    defaultModels: { audio: DEFAULT_STT_MODEL },
    resolveAuth: () => ({ kind: "none", source: "local loopback media service" }),
    async transcribeAudio(req) {
      const baseUrl = requireLoopbackBaseUrl(req.baseUrl, "Local media STT");
      const lease = await acquireLocalService(
        {
          providerId: LOCAL_MEDIA_PROVIDER_ID,
          baseUrl,
          headers: req.headers,
        },
        req.signal,
      );
      try {
        return await transcribeOpenAiCompatibleAudio({
          ...req,
          apiKey: "",
          auth: { kind: "none", source: "local loopback media service" },
          baseUrl,
          defaultBaseUrl: baseUrl,
          defaultModel: DEFAULT_STT_MODEL,
          provider: LOCAL_MEDIA_PROVIDER_ID,
          fetchFn: fetch,
          request: {
            ...req.request,
            allowPrivateNetwork: true,
          },
        });
      } finally {
        lease?.release();
      }
    },
  };
}

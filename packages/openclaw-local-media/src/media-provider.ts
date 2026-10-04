import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  transcribeOpenAiCompatibleAudio,
  type MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
import { DEFAULT_STT_MODEL, LOCAL_MEDIA_PROVIDER_ID } from "./constants.js";
import { requireLoopbackBaseUrl } from "./local-url.js";
import { createMediaRequestLifecycle } from "./request-lifecycle.js";

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
      const headers = new Headers(req.headers);
      headers.delete("x-openclaw-speech-input");
      headers.delete("x-openclaw-request-id");
      headers.delete("x-openclaw-request-timeout-ms");
      if (req.speechInput) headers.set("x-openclaw-speech-input", "agent-speech");
      const requestHeaders = Object.fromEntries(headers.entries());
      const job = createMediaRequestLifecycle({
        baseUrl,
        timeoutMs: req.timeoutMs,
        signal: req.signal,
      });
      let lease: Awaited<ReturnType<AcquireLocalService>>;
      try {
        job.signal.throwIfAborted();
        lease = await acquireLocalService(
          {
            providerId: LOCAL_MEDIA_PROVIDER_ID,
            baseUrl,
            headers: requestHeaders,
          },
          job.signal,
        );
        job.signal.throwIfAborted();
        return await transcribeOpenAiCompatibleAudio({
          ...req,
          signal: job.signal,
          apiKey: "",
          auth: { kind: "none", source: "local loopback media service" },
          baseUrl,
          headers: { ...requestHeaders, ...job.headers },
          defaultBaseUrl: baseUrl,
          defaultModel: DEFAULT_STT_MODEL,
          provider: LOCAL_MEDIA_PROVIDER_ID,
          fetchFn: fetch,
          request: {
            ...req.request,
            allowPrivateNetwork: true,
          },
        });
      } catch (error) {
        await job.cancel();
        throw error;
      } finally {
        job.finish();
        await lease?.release();
      }
    },
  };
}

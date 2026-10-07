import { readFileSync } from "node:fs";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { parseVoiceassistantConfig } from "./config.js";
import { createVoiceassistantNodePolicy, VOICEASSISTANT_COMMAND } from "./node-policy.js";
import { VoiceassistantService } from "./service.js";

const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8")) as {
  configSchema?: unknown;
};
if (!manifest.configSchema || typeof manifest.configSchema !== "object") {
  throw new Error("voiceassistant manifest is missing configSchema");
}

export default definePluginEntry({
  id: "voiceassistant",
  name: "Voiceassistant",
  description: "Paired Pi audio routed through OpenClaw's shared Meeting engine.",
  configSchema: manifest.configSchema as never,
  register(api) {
    const config = parseVoiceassistantConfig(api.pluginConfig);
    // This registration binds service-owned node access to this plugin. The
    // Gateway implementation is the separate, paired Pi; ordinary node hosts
    // do not receive a second implementation of the media command.
    api.registerNodeHostCommand({
      command: VOICEASSISTANT_COMMAND,
      cap: VOICEASSISTANT_COMMAND,
      dangerous: true,
      handle: async () => JSON.stringify({ error: "voiceassistant command is Pi-only" }),
    });
    api.registerNodeInvokePolicy(createVoiceassistantNodePolicy(config));
    let controller: VoiceassistantService | undefined;
    api.registerService({
      id: "voiceassistant",
      reload: { configPrefixes: ["plugins.entries.voiceassistant.config"] },
      start(ctx) {
        controller = new VoiceassistantService(api, ctx, config);
        controller.start();
      },
      async stop() {
        await controller?.stop();
        controller = undefined;
      },
    });
  },
});

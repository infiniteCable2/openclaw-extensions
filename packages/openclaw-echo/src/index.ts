import { readFileSync } from "node:fs";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { readEchoBindings } from "./contract.js";
import { registerEchoTools } from "./device-tools.js";

const manifest = JSON.parse(
  readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
) as {
  configSchema?: unknown;
};
if (!manifest.configSchema || typeof manifest.configSchema !== "object") {
  throw new Error("Echo manifest is missing configSchema");
}

export default definePluginEntry({
  id: "echo",
  name: "Echo Devices",
  description: "Read and control assigned Echo speakers through their native node connection.",
  configSchema: manifest.configSchema as never,
  register(api) {
    readEchoBindings(api.pluginConfig);
    registerEchoTools(api);
  },
});

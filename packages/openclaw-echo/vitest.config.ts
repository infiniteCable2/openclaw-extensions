import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@infinitecable2/openclaw-device-management/policy": fileURLToPath(
        new URL("../openclaw-device-management/src/policy.ts", import.meta.url),
      ),
    },
  },
  test: { environment: "node" },
});

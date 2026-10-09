import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Test the current public policy export's implementation without building dist.
  // Runtime imports continue to use the dependency's published /policy export.
  resolve: { alias: {
    "@infinitecable2/openclaw-device-management/policy": fileURLToPath(new URL("../openclaw-device-management/src/policy.ts", import.meta.url)),
  } },
  test: { exclude: ["dist/**", "node_modules/**"] },
});

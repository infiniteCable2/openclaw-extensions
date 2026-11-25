import { main } from "./collector.mjs";

try {
  await main(process.argv.slice(2));
} catch {
  // Logs deliberately contain no command output, credential, host or local path.
  process.stderr.write("server-watch collection failed\n");
  process.exitCode = 1;
}

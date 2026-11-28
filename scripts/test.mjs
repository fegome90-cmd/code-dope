import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = readdirSync(new URL("../tests/", import.meta.url))
  .filter((name) => name.endsWith(".test.ts") && name !== "package.test.ts")
  .sort().map((name) => `tests/${name}`);
const run = spawnSync(process.execPath, ["--test", ...files], { cwd: root, stdio: "inherit" });
if (run.error) throw run.error;
process.exitCode = run.status ?? 1;

import { cpSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = new URL("../dist/", import.meta.url);
rmSync(dist, { recursive: true, force: true });
execFileSync(process.execPath, [fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)), "-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" });
cpSync(new URL("../src/sandbox/", import.meta.url), new URL("../dist/sandbox/", import.meta.url), { recursive: true });

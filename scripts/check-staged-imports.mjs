import { execFileSync } from "node:child_process";
import { posix } from "node:path";

const gitRaw = (...args) =>
  execFileSync("git", args, { maxBuffer: 16 * 1024 * 1024 });
const names = (buffer) => buffer.toString("utf8").split("\0").filter(Boolean);

// -z evita que Git cite rutas no ASCII, que luego no coincidirían con `git show :ruta`.
const staged = names(gitRaw("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"))
  .filter((file) => /\.(ts|tsx)$/.test(file) && !/^dist\/.*\.d\.ts$/.test(file));

if (staged.length === 0) process.exit(0);

const tracked = new Set(names(gitRaw("ls-files", "-z")));
const missing = [];

for (const file of staged) {
  const source = gitRaw("show", `:${file}`).toString("utf8");
  const dir = posix.dirname(file);
  for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s*)["'](\.[^"']+)["']/g)) {
    const target = posix.normalize(posix.join(dir, match[1]));
    if (!tracked.has(target)) missing.push(`${file} -> ${match[1]} (no está en el índice)`);
  }
}

if (missing.length > 0) {
  console.error("Imports staged que no existen en el índice:\n" + missing.join("\n"));
  process.exit(1);
}

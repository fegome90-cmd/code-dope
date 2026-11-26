import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("el tarball se importa y tipa fuera del repo, sin dependencias runtime", () => {
  const cwd = mkdtempSync(join(tmpdir(), "code dope consumer "));
  const run = (bin, args, dir = cwd) =>
    execFileSync(bin, args, { cwd: dir, encoding: "utf8" });
  try {
    const output = run(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", cwd],
      fileURLToPath(new URL("..", import.meta.url)),
    );
    const [tar] = JSON.parse(output);
    assert.deepEqual(tar.files.map(({ path }) => path).sort(), [
      "README.md",
      "dist/index.d.ts",
      "dist/index.js",
      "package.json",
    ]);
    writeFileSync(
      join(cwd, "package.json"),
      '{"private":true,"type":"module"}\n',
    );
    run("npm", [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(cwd, tar.filename),
    ]);
    const installed = JSON.parse(
      readFileSync(join(cwd, "node_modules/code-dope/package.json"), "utf8"),
    );
    assert.deepEqual(installed.dependencies ?? {}, {});
    run(process.execPath, [
      "--input-type=module",
      "-e",
      'import { stage } from "code-dope"; if (stage !== "bootstrap") process.exit(1);',
    ]);
    writeFileSync(
      join(cwd, "consumer.ts"),
      'import { stage } from "code-dope";\nconst verified: "bootstrap" = stage;\n',
    );
    const tsc = fileURLToPath(
      new URL("../node_modules/typescript/bin/tsc", import.meta.url),
    );
    run(process.execPath, [
      tsc,
      "--noEmit",
      "--strict",
      "--module",
      "NodeNext",
      "consumer.ts",
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

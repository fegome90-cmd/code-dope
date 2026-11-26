import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./check-dist.mjs", import.meta.url));

test("distribution check rejects tracked drift and omitted generated files, including ignored files", () => {
  const root = mkdtempSync(join(tmpdir(), "code-dope-dist-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  const check = () => spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
  try {
    git("init", "--quiet");
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist/index.js"), "export const value = 1;\n");
    git("add", "dist");
    assert.equal(check().status, 0);
    writeFileSync(join(root, "dist/index.js"), "export const value = 2;\n");
    assert.notEqual(check().status, 0, "tracked drift must fail");
    git("add", "dist");
    writeFileSync(join(root, ".gitignore"), "dist/new.js\n");
    writeFileSync(join(root, "dist/new.js"), "export const added = true;\n");
    const omitted = check();
    assert.notEqual(omitted.status, 0);
    assert.match(omitted.stderr, /Untracked generated files/);
    git("add", "--force", "dist/new.js");
    assert.equal(check().status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

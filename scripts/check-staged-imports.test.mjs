import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const guard = fileURLToPath(new URL("./check-staged-imports.mjs", import.meta.url));
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), "code-dope-imports-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  return dir;
}

const run = (dir) => spawnSync(process.execPath, [guard], { cwd: dir, encoding: "utf8" });

test("positivo: import con destino en el índice pasa", (t) => {
  const dir = repo(t);
  writeFileSync(join(dir, "b.ts"), "export const b = 1;\n");
  writeFileSync(join(dir, "a.ts"), 'import { b } from "./b.ts";\nexport const x = b;\n');
  git(dir, "add", "a.ts", "b.ts");
  assert.equal(run(dir).status, 0);
});

test("negativo: destino existe en disco pero no está en el índice", (t) => {
  const dir = repo(t);
  writeFileSync(join(dir, "b.ts"), "export const b = 1;\n");
  writeFileSync(join(dir, "a.ts"), 'import { b } from "./b.ts";\nexport const x = b;\n');
  git(dir, "add", "a.ts");
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no está en el índice/);
});

test("fallo parcial: informa sólo el import ausente", (t) => {
  const dir = repo(t);
  writeFileSync(join(dir, "b.ts"), "export const b = 1;\n");
  writeFileSync(join(dir, "c.ts"), "export const c = 2;\n");
  writeFileSync(join(dir, "a.ts"), 'import { b } from "./b.ts";\nimport { c } from "./c.ts";\n');
  git(dir, "add", "a.ts", "b.ts");
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.\/c\.ts/);
  assert.doesNotMatch(result.stderr, /\.\/b\.ts/);
});

test("negativo: import de efecto secundario también se comprueba", (t) => {
  const dir = repo(t);
  writeFileSync(join(dir, "b.ts"), "export const b = 1;\n");
  writeFileSync(join(dir, "a.ts"), 'import "./b.ts";\n');
  git(dir, "add", "a.ts");
  assert.equal(run(dir).status, 1);
});

test("rutas no ASCII se manejan sin stack trace", (t) => {
  const dir = repo(t);
  writeFileSync(join(dir, "b.ts"), "export const b = 1;\n");
  writeFileSync(join(dir, "á.ts"), 'import { b } from "./b.ts";\nexport const x = b;\n');
  git(dir, "add", "á.ts");
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no está en el índice/);
  assert.doesNotMatch(result.stderr, /Error:|at /);
});

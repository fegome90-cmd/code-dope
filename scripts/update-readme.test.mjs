import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { isSyncCommit, parseGitLogRecords } from "./update-readme.mjs";

const SCRIPT_PATH = resolve("scripts/update-readme.mjs");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "code-dope-readme-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.name", "Test User"]);
  git(dir, ["config", "user.email", "test@example.invalid"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

function seedManagedFiles(dir) {
  mkdirSync(join(dir, "assets", "readme"), { recursive: true });
  writeFileSync(
    join(dir, "README.md"),
    [
      "# Test",
      "",
      "<!-- AUTO:STATUS:START -->",
      "placeholder",
      "<!-- AUTO:STATUS:END -->",
      "",
      "<!-- AUTO:MODULES:START -->",
      "placeholder",
      "<!-- AUTO:MODULES:END -->",
      "",
      "<!-- AUTO:BENCHMARKS:START -->",
      "placeholder",
      "<!-- AUTO:BENCHMARKS:END -->",
      "",
      "<!-- AUTO:RECENT_MERGES:START -->",
      "placeholder",
      "<!-- AUTO:RECENT_MERGES:END -->",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(dir, "assets", "readme", "status-badge.svg"),
    [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 100" width="1200" height="100">',
      "  <!-- AUTO:SVG_STATUS:START -->",
      "  <g/>",
      "  <!-- AUTO:SVG_STATUS:END -->",
      "</svg>",
      "",
    ].join("\n"),
    "utf8",
  );
}

test("isSyncCommit identifies merge, squash, trailer, and skip-ci sync commits", () => {
  assert.equal(
    isSyncCommit("Merge pull request #12 from org/docs/sync-readme"),
    true,
  );
  assert.equal(
    isSyncCommit("docs(readme): sync README metrics and modules (#12)"),
    true,
  );
  assert.equal(
    isSyncCommit("chore: manual squash title", "Auto-Sync: readme"),
    true,
  );
  assert.equal(isSyncCommit("docs(readme): refresh [skip ci]"), true);
  assert.equal(isSyncCommit("feat(policy): add strict approve gate"), false);
  assert.equal(isSyncCommit("docs(readme): add architecture diagram"), false);
});

test("parseGitLogRecords filters sync commits and honors limit", () => {
  const raw = [
    [
      "aaa1111",
      "2026-11-26",
      "docs(readme): sync README metrics and modules",
      "Auto-Sync: readme",
    ].join("\x1f"),
    ["bbb2222", "2026-11-26", "feat: add executor", "Body text"].join("\x1f"),
    [
      "ccc3333",
      "2026-11-25",
      "Merge pull request #7 from fegome90-cmd/docs/sync-readme",
      "",
    ].join("\x1f"),
    ["ddd4444", "2026-11-25", "chore: bootstrap", ""].join("\x1f"),
  ].join("\x1e");

  const one = parseGitLogRecords(raw, 1);
  assert.deepEqual(one, [
    { sha: "bbb2222", date: "2026-11-26", subject: "feat: add executor" },
  ]);

  const two = parseGitLogRecords(raw, 5);
  assert.deepEqual(two, [
    { sha: "bbb2222", date: "2026-11-26", subject: "feat: add executor" },
    { sha: "ddd4444", date: "2026-11-25", subject: "chore: bootstrap" },
  ]);
});

test("update-readme converges to a fixed point after committing a sync PR and flags new drift", () => {
  const dir = createTempRepo();
  try {
    seedManagedFiles(dir);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "code-dope", version: "0.1.0" }),
      "utf8",
    );
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "feat: initial code"]);

    execFileSync(process.execPath, [SCRIPT_PATH], {
      cwd: dir,
      encoding: "utf8",
    });

    // Simulate merging the sync PR (commit without [skip ci], using Auto-Sync trailer).
    git(dir, ["add", "README.md", "assets/readme/status-badge.svg"]);
    git(dir, [
      "commit",
      "-m",
      "docs(readme): sync README metrics and modules",
      "-m",
      "Auto-Sync: readme",
    ]);

    // Fixed-point check: --check must exit 0 even though a new sync commit became HEAD.
    const checkOut = execFileSync(process.execPath, [SCRIPT_PATH, "--check"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.match(checkOut, /up to date/);

    // A new non-sync commit must cause --check to fail with exit 1.
    writeFileSync(
      join(dir, "README.md"),
      readFileSync(join(dir, "README.md"), "utf8"),
      "utf8",
    );
    writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n", "utf8");
    git(dir, ["add", "CHANGELOG.md"]);
    git(dir, ["commit", "-m", "docs: add changelog"]);

    assert.throws(
      () =>
        execFileSync(process.execPath, [SCRIPT_PATH, "--check"], {
          cwd: dir,
          stdio: "pipe",
        }),
      (err) => err.status === 1,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("update-readme handles repos containing only sync commits without crashing", () => {
  const dir = createTempRepo();
  try {
    seedManagedFiles(dir);
    git(dir, ["add", "."]);
    git(dir, [
      "commit",
      "-m",
      "docs(readme): sync README metrics and modules",
      "-m",
      "Auto-Sync: readme",
    ]);

    execFileSync(process.execPath, [SCRIPT_PATH], {
      cwd: dir,
      encoding: "utf8",
    });
    const readme = readFileSync(join(dir, "README.md"), "utf8");
    assert.match(readme, /`0000000` \(unknown\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

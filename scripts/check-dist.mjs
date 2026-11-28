import { execFileSync } from "node:child_process";

try {
  execFileSync("git", ["diff", "--exit-code", "--", "dist/"], { stdio: "inherit" });
  const untracked = execFileSync("git", ["ls-files", "--others", "-z", "--", "dist/"]);
  if (untracked.length) {
    console.error("Untracked generated files in dist/: build and stage the complete distribution.");
    process.exitCode = 1;
  }
} catch {
  process.exitCode = 1;
}

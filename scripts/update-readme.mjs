#!/usr/bin/env node
/**
 * Deterministically updates auto-managed sections in README.md and
 * assets/readme/status-badge.svg from live repository state and git history.
 *
 * Usage:
 *   node scripts/update-readme.mjs          # Update files in place
 *   node scripts/update-readme.mjs --check  # Exit non-zero if any file differs
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";

const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "__pycache__"]);
const IGNORED_FILES = new Set([".DS_Store"]);

function resolveRepoRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return process.cwd();
  }
}

function runGit(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readTextIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, "utf8").trim();
}

function walkFiles(rootDir, relDir) {
  const start = join(rootDir, relDir);
  if (!existsSync(start)) return [];
  const results = [];

  function visit(absDir, currentRel) {
    const entries = readdirSync(absDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name, "en"),
    );
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name) || IGNORED_FILES.has(entry.name)) continue;
      if (entry.name.endsWith(".pyc")) continue;
      const nextAbs = join(absDir, entry.name);
      const nextRel = posix.join(currentRel, entry.name);
      if (entry.isDirectory()) {
        visit(nextAbs, nextRel);
      } else if (entry.isFile()) {
        results.push(nextRel);
      }
    }
  }

  visit(start, relDir);
  return results;
}

function escapeMarkdownCell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatNumber(n) {
  return typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : String(n);
}

function parseGitLogLines(raw, limit = 5) {
  if (!raw) return [];
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [sha = "", date = "", ...subjectParts] = line.split("\t");
    const subject = subjectParts.join("\t").trim();
    if (!sha || subject.includes("[skip ci]")) continue;
    rows.push({ sha, date, subject });
    if (rows.length >= limit) break;
  }
  return rows;
}

function collectRepoState(root) {
  const pkg = readJsonIfExists(join(root, "package.json"));
  const nodeVersion = readTextIfExists(join(root, ".node-version"));
  const bench = readJsonIfExists(join(root, "bench", "RESULTS.json"));
  const catalog = readJsonIfExists(join(root, "catalog", "patterns.json"));

  const srcFiles = walkFiles(root, "src");
  const exampleFiles = walkFiles(root, "examples");
  const snippetFiles = walkFiles(root, "snippets");
  const testFiles = walkFiles(root, "tests");
  const scriptFiles = walkFiles(root, "scripts");

  const headRaw = runGit(root, ["log", "-1", "--format=%h%x09%cs"]);
  const [headSha = "0000000", headDate = "unknown"] = headRaw ? headRaw.split("\t") : [];

  const mergesRaw = runGit(root, ["log", "--merges", "-n", "25", "--format=%h%x09%cs%x09%s"]);
  const mergeRows = parseGitLogLines(mergesRaw, 5);
  const usingFallbackCommits = mergeRows.length === 0;
  const commitRows = usingFallbackCommits
    ? parseGitLogLines(runGit(root, ["log", "-n", "25", "--format=%h%x09%cs%x09%s"]), 5)
    : mergeRows;

  const hasCoreLibrary =
    srcFiles.includes("src/policy.ts") ||
    srcFiles.includes("src/mcp.ts") ||
    srcFiles.length > 1;
  const hasBootstrapSrc = srcFiles.length > 0 && !hasCoreLibrary;

  let nodeTarget = ">=22.18 (pending PR merge)";
  if (pkg?.engines?.node && nodeVersion) {
    nodeTarget = `${pkg.engines.node} (.node-version: ${nodeVersion})`;
  } else if (pkg?.engines?.node) {
    nodeTarget = String(pkg.engines.node);
  } else if (nodeVersion) {
    nodeTarget = nodeVersion;
  }

  return {
    pkg,
    nodeVersion,
    nodeTarget,
    bench,
    catalog,
    srcFiles,
    exampleFiles,
    snippetFiles,
    testFiles,
    scriptFiles,
    headSha,
    headDate,
    commitRows,
    usingFallbackCommits,
    hasCoreLibrary,
    hasBootstrapSrc,
  };
}

function renderStatusBlock(state) {
  const { pkg, nodeTarget, srcFiles, exampleFiles, snippetFiles, testFiles, scriptFiles, headSha, headDate, hasCoreLibrary, hasBootstrapSrc } =
    state;

  const branchRelease =
    !pkg && srcFiles.length === 0
      ? "`main` · pre-merge (docs & sync)"
      : `\`v${pkg?.version ?? "0.0.0"}\` (\`main\`)`;

  const coreLibraryStatus = hasCoreLibrary
    ? "Merged on `main`"
    : hasBootstrapSrc
      ? "Bootstrap on `main` (PR #2 pending)"
      : "Pending merge (PR #1 / PR #2)";

  const trackedSummary = `${srcFiles.length} src · ${exampleFiles.length + snippetFiles.length} examples/snippets · ${testFiles.length} tests · ${scriptFiles.length} scripts`;

  return [
    "| Field | Value |",
    "| --- | --- |",
    `| Branch / Release | ${branchRelease} |`,
    `| Node.js Target | \`${escapeMarkdownCell(nodeTarget)}\` |`,
    `| Tracked Files | ${trackedSummary} |`,
    `| HEAD Commit | \`${headSha}\` (${headDate}) |`,
    `| Core Library | ${coreLibraryStatus} |`,
  ].join("\n");
}

function summarizeFileList(files, limit = 6) {
  if (files.length === 0) return "—";
  const shown = files.slice(0, limit).map((f) => `\`${f}\``);
  if (files.length > limit) {
    shown.push(`+${files.length - limit} more`);
  }
  return shown.join(", ");
}

function renderModulesBlock(state) {
  const areas = [
    { name: "`src/`", files: state.srcFiles, pendingNote: "Pending merge (`PR #2 feat/code-mode-library`)" },
    { name: "`examples/`", files: state.exampleFiles, pendingNote: "Pending merge (`PR #2 feat/code-mode-library`)" },
    { name: "`snippets/`", files: state.snippetFiles, pendingNote: "Pending merge (`PR #2 feat/code-mode-library`)" },
    { name: "`scripts/`", files: state.scriptFiles, pendingNote: "No scripts found" },
  ];

  const rows = [
    "| Area | Files | Contents |",
    "| --- | --- | --- |",
  ];

  for (const area of areas) {
    const count = area.files.length;
    const contents = count > 0 ? summarizeFileList(area.files) : area.pendingNote;
    rows.push(`| ${area.name} | ${count} | ${contents} |`);
  }

  return rows.join("\n");
}

function renderBenchmarksBlock(state) {
  const { bench, catalog } = state;

  if (!bench && !catalog) {
    return [
      "| Source | Status | Details |",
      "| --- | --- | --- |",
      "| `bench/RESULTS.json` | Pending PR #2 merge | Auto-populates measured Code Mode vs baseline metrics upon merge |",
      "| `catalog/patterns.json` | Pending PR #2 merge | Auto-populates indexed pattern counts and levels upon merge |",
    ].join("\n");
  }

  const lines = [];

  if (bench?.measured) {
    const m = bench.measured;
    const d = bench.derived_scripted;
    const baselineOut = m.toolOutputCharsReachingModel?.baseline;
    const candidateOut = m.toolOutputCharsReachingModel?.candidate;
    const reduction =
      typeof baselineOut === "number" && typeof candidateOut === "number" && baselineOut > 0
        ? ` (**-${(((baselineOut - candidateOut) / baselineOut) * 100).toFixed(1)}%**)`
        : "";

    lines.push(
      `Measured on Node \`${escapeMarkdownCell(bench.node ?? "unknown")}\` (${formatNumber(bench.runs ?? 0)} runs, \`${escapeMarkdownCell(bench.date ?? "")}\`) — ${escapeMarkdownCell(bench.workflow ?? "synthetic MCP benchmark")}:`,
      "",
      "| Metric | Baseline (tool-by-tool) | Code Mode | Source |",
      "| --- | --- | --- | --- |",
    );

    if (m.toolInvocations) {
      lines.push(
        `| Tool invocations | ${formatNumber(m.toolInvocations.baseline)} | ${formatNumber(m.toolInvocations.candidate)} | Measured |`,
      );
    }
    if (m.toolOutputCharsReachingModel) {
      lines.push(
        `| Tool output chars reaching model | ${formatNumber(baselineOut)} | ${formatNumber(candidateOut)}${reduction} | Measured |`,
      );
    }
    if (m.toolDefinitionChars) {
      lines.push(
        `| Tool definition chars | ${formatNumber(m.toolDefinitionChars.baseline)} | ${formatNumber(m.toolDefinitionChars.candidate)} | Measured |`,
      );
    }
    if (typeof m.candidateCodeChars_modelOutput === "number") {
      lines.push(
        `| Model-written code chars | — | ${formatNumber(m.candidateCodeChars_modelOutput)} | Measured |`,
      );
    }
    if (m.toolWallClockMsMedian) {
      lines.push(
        `| Median wall-clock (ms) | ${m.toolWallClockMsMedian.baseline} ms | ${m.toolWallClockMsMedian.candidateWorker} ms (worker) / ${m.toolWallClockMsMedian.candidateInline} ms (inline) | Measured |`,
      );
    }
    if (m.onFailure_customer_c1_unavailable) {
      const failBase = m.onFailure_customer_c1_unavailable.baseline;
      const failCand = m.onFailure_customer_c1_unavailable.candidate;
      lines.push(
        `| Partial failure handling | ${failBase?.errorsReturnedToModel ?? 1} error (+${failBase?.extraTurnsToHandle ?? 1} extra turn) | \`complete: ${failCand?.complete}\`, ${failCand?.partialOrdersReturned ?? 0} partial orders, ${failCand?.failedCustomers?.length ?? 0} failed | Measured |`,
      );
    }
    if (d?.modelTurns) {
      lines.push(
        `| Model turns | ${d.modelTurns.baselineSequential} (seq) / ${d.modelTurns.baselineParallelToolUse} (parallel) | ${d.modelTurns.candidate} | Derived (scripted) |`,
      );
    }
    if (d?.cumulativeContextCharsEstimate) {
      lines.push(
        `| Cumulative context chars estimate | ${formatNumber(d.cumulativeContextCharsEstimate.baselineSequential)} | ${formatNumber(d.cumulativeContextCharsEstimate.candidate)} | Derived (scripted) |`,
      );
    }
  }

  if (catalog?.patterns && Array.isArray(catalog.patterns)) {
    const levelCounts = new Map();
    for (const pattern of catalog.patterns) {
      const lvl = pattern.level ?? "other";
      levelCounts.set(lvl, (levelCounts.get(lvl) ?? 0) + 1);
    }
    const levelSummary = [...levelCounts.entries()]
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([lvl, cnt]) => `L${lvl}: ${cnt}`)
      .join(" · ");

    if (lines.length > 0) lines.push("");
    lines.push(
      `**Pattern Catalog (\`catalog/patterns.json\`, v${escapeMarkdownCell(catalog.version ?? "0.0.0")}):** ${catalog.patterns.length} indexed patterns (${levelSummary}).`,
    );
  }

  if (Array.isArray(bench?.NOT_VERIFIED) && bench.NOT_VERIFIED.length > 0) {
    lines.push("", `**Not verified in synthetic bench:** ${bench.NOT_VERIFIED.map(escapeMarkdownCell).join("; ")}.`);
  }

  return lines.join("\n");
}

function renderRecentMergesBlock(state) {
  const { commitRows, usingFallbackCommits } = state;
  const lines = [];

  if (usingFallbackCommits) {
    lines.push("Showing latest commits on `main` (no PR merge commits yet).", "");
  }

  lines.push("| Commit | Date | Summary |", "| --- | --- | --- |");

  if (commitRows.length === 0) {
    lines.push("| — | — | No non-bot commits found |");
  } else {
    for (const row of commitRows) {
      lines.push(`| \`${row.sha}\` | ${row.date} | ${escapeMarkdownCell(row.subject)} |`);
    }
  }

  return lines.join("\n");
}

function renderSvgStatusInner(state) {
  const { pkg, srcFiles, testFiles, catalog, bench, headSha, headDate } = state;

  const mainState =
    !pkg && srcFiles.length === 0
      ? "Pre-merge"
      : `v${pkg?.version ?? "0.0.0"}`;
  const mainStateColor = !pkg && srcFiles.length === 0 ? "#58A6FF" : "#3FB950";

  const codeModules =
    srcFiles.length > 0
      ? `${srcFiles.length} src · ${testFiles.length} tests`
      : "0 src · scripts ready";

  let patternsBench = "Pending PR #2";
  let patternsBenchColor = "#F0F6FC";
  const patternCount = Array.isArray(catalog?.patterns) ? catalog.patterns.length : null;
  const benchRuns = typeof bench?.runs === "number" ? bench.runs : null;
  if (patternCount !== null && benchRuns !== null) {
    patternsBench = `${patternCount} patterns · ${benchRuns} runs`;
    patternsBenchColor = "#3FB950";
  } else if (patternCount !== null) {
    patternsBench = `${patternCount} patterns`;
    patternsBenchColor = "#3FB950";
  } else if (benchRuns !== null) {
    patternsBench = `${benchRuns} bench runs`;
    patternsBenchColor = "#3FB950";
  }

  const headSync = `${headSha} · ${headDate}`;

  const columns = [
    { x: 48, label: "MAIN STATE", value: mainState, color: mainStateColor, mono: false },
    { x: 340, label: "CODE MODULES", value: codeModules, color: "#F0F6FC", mono: false },
    { x: 632, label: "PATTERNS / BENCH", value: patternsBench, color: patternsBenchColor, mono: false },
    { x: 924, label: "HEAD SYNC", value: headSync, color: "#3FB950", mono: true },
  ];

  const textNodes = columns
    .map((col) => {
      const valueFont = col.mono
        ? ` font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"`
        : "";
      return (
        `    <text x="${col.x}" y="38" fill="#8B949E" font-size="16" font-weight="600" letter-spacing="0.5">${escapeXml(col.label)}</text>\n` +
        `    <text x="${col.x}" y="70" fill="${col.color}" font-size="22" font-weight="600"${valueFont}>${escapeXml(col.value)}</text>`
      );
    })
    .join("\n\n");

  return `  <g id="auto-status" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif">\n${textNodes}\n  </g>`;
}

function replaceMarkerBlock(content, markerName, newInner, filePath) {
  const pattern = new RegExp(
    `([ \\t]*)<!-- AUTO:${markerName}:START -->[\\s\\S]*?([ \\t]*)<!-- AUTO:${markerName}:END -->`,
    "g",
  );
  const matches = [...content.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(
      `${filePath}: expected exactly 1 <!-- AUTO:${markerName}:START/END --> block, found ${matches.length}`,
    );
  }
  return content.replace(
    pattern,
    (_full, startIndent, endIndent) =>
      `${startIndent}<!-- AUTO:${markerName}:START -->\n${newInner}\n${endIndent}<!-- AUTO:${markerName}:END -->`,
  );
}

function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const unknownArgs = args.filter((a) => a !== "--check");
  if (unknownArgs.length > 0) {
    console.error(`Unknown argument(s): ${unknownArgs.join(", ")}`);
    process.exit(2);
  }

  const root = resolveRepoRoot();
  const state = collectRepoState(root);

  const readmePath = join(root, "README.md");
  if (!existsSync(readmePath)) {
    console.error(`Missing README.md at ${readmePath}`);
    process.exit(1);
  }

  const readmeOriginal = readFileSync(readmePath, "utf8");
  let readmeUpdated = readmeOriginal;
  readmeUpdated = replaceMarkerBlock(readmeUpdated, "STATUS", renderStatusBlock(state), "README.md");
  readmeUpdated = replaceMarkerBlock(readmeUpdated, "MODULES", renderModulesBlock(state), "README.md");
  readmeUpdated = replaceMarkerBlock(readmeUpdated, "BENCHMARKS", renderBenchmarksBlock(state), "README.md");
  readmeUpdated = replaceMarkerBlock(readmeUpdated, "RECENT_MERGES", renderRecentMergesBlock(state), "README.md");

  const targets = [
    { rel: "README.md", path: readmePath, original: readmeOriginal, updated: readmeUpdated },
  ];

  const svgPath = join(root, "assets", "readme", "status-badge.svg");
  if (existsSync(svgPath)) {
    const svgOriginal = readFileSync(svgPath, "utf8");
    const svgUpdated = replaceMarkerBlock(
      svgOriginal,
      "SVG_STATUS",
      renderSvgStatusInner(state),
      "assets/readme/status-badge.svg",
    );
    targets.push({
      rel: "assets/readme/status-badge.svg",
      path: svgPath,
      original: svgOriginal,
      updated: svgUpdated,
    });
  }

  const changed = targets.filter((t) => t.original !== t.updated);

  if (checkOnly) {
    if (changed.length > 0) {
      console.error(
        `README auto-sync drift detected in: ${changed.map((c) => c.rel).join(", ")}. Run \`node scripts/update-readme.mjs\`.`,
      );
      process.exit(1);
    }
    console.log(`OK: ${targets.map((t) => t.rel).join(", ")} up to date.`);
    return;
  }

  for (const item of changed) {
    writeFileSync(item.path, item.updated, "utf8");
  }
  if (changed.length > 0) {
    console.log(`Updated: ${changed.map((c) => c.rel).join(", ")}`);
  } else {
    console.log(`No changes needed (${targets.map((t) => t.rel).join(", ")}).`);
  }
}

main();

import { pathToFileURL } from "node:url";
import { evaluate } from "./evaluate.mjs";
import { collectSnapshot } from "./github.mjs";

export const USAGE = "Uso: node scripts/premerge/cli.mjs --pr N [--intent normal|bootstrap|sync]";

export async function run(args, { collect = collectSnapshot, print = console.log } = {}) {
  if (args.length === 1 && args[0] === "--help") {
    print(USAGE);
    return 0;
  }
  if (![2, 4].includes(args.length) || args[0] !== "--pr" || !/^[1-9][0-9]*$/.test(args[1]) ||
      (args.length === 4 && (args[2] !== "--intent" || !["normal", "bootstrap", "sync"].includes(args[3])))) {
    print(USAGE);
    return 2;
  }
  const number = Number(args[1]);
  if (!Number.isSafeInteger(number) || number === 2) {
    print(JSON.stringify({ status: "BLOCKED_EVIDENCE", reason: "PR_OUT_OF_SCOPE", nextStep: "Usa un PR dentro del alcance acordado." }));
    return 2;
  }
  let result;
  try {
    result = evaluate(await collect(number, { intent: args[3] ?? "normal" }));
  } catch {
    print(JSON.stringify({ status: "BLOCKED_EVIDENCE", reason: "READ_FAILED", nextStep: "Recupera el acceso de lectura y comprueba de nuevo." }));
    return 1;
  }
  print(JSON.stringify(result));
  return result.status === "READY" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run(process.argv.slice(2));
}

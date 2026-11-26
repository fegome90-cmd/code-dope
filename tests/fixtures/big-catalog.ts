import { z } from "zod";
import { ordersServer } from "./servers.ts";

/** Orders server plus `n` unrelated synthetic tools, to exercise discovery on a large catalog. */
export function bigCatalogServer(n = 80) {
  const { server, counters } = ordersServer();
  const domains = ["calendar", "invoice", "inventory", "payroll", "shipping", "marketing", "analytics", "storage"];
  for (let i = 0; i < n; i++) {
    const d = domains[i % domains.length];
    server.registerTool(`${d}_action_${i}`, {
      description: `Perform ${d} operation number ${i} with detailed configuration options for ${d} workflows.`,
      inputSchema: { id: z.string().describe(`${d} identifier`), options: z.object({ mode: z.enum(["a", "b", "c"]), limit: z.number().optional() }).optional() },
    }, async () => ({ content: [{ type: "text" as const, text: "{}" }] }));
  }
  return { server, counters };
}

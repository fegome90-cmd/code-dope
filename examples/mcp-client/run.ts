/** MCP client: spawn examples/mcp-server over stdio and call the `code` tool with a library recipe. */
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { paginatedFilter } from "../../src/recipes.ts";

const which = process.argv[2] ?? "orders";
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../mcp-server/server.ts", import.meta.url)), which],
  stderr: "ignore",
});
const client = new Client({ name: "example-client", version: "1.0.0" });
await client.connect(transport);
console.log("tools:", (await client.listTools()).tools.map((t) => t.name));
const code = which === "tickets"
  ? paginatedFilter.build({ listTool: "search_tickets", cursorArg: "page_token", itemsField: "results", nextField: "nextPageToken", where: { state: "open" }, fields: ["ticketId", "priority"], groupBy: "priority" })
  : paginatedFilter.build({ listTool: "list_orders", where: { status: "pending" }, fields: ["id", "customerId", "total"], groupBy: "customerId" });
const r = await client.callTool({ name: "code", arguments: { code } });
console.log((r.content as Array<{ text: string }>)[0].text);
await client.close();

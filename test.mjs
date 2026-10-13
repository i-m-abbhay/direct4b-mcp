// Offline asserts + a read-only live smoke test over stdio (skipped without a token).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { sinceToId, renderContent } from "./dist/index.js";

// Real message 1614599054338031616 was sent at 2024-10-12T01:40:12.369Z.
// (the id's embedded time is ~15ms off created_at, so compare within 1s)
const drift = (BigInt(sinceToId("2024-10-12T01:40:12.369Z")) >> 22n) - (1614599054338031616n >> 22n);
assert.ok(drift >= -1000n && drift <= 1000n, `drift ${drift}ms`);
assert.equal(BigInt(sinceToId("2h", 1e12)) >> 22n, BigInt(1e12 - 2 * 3600e3) - 1343746800000n);
assert.throws(() => sinceToId("yesterday-ish"));
assert.equal(renderContent({ type: 500, content: { question: "OK?" } }), "[yes/no] OK?");
assert.equal(renderContent({ type: 502 }), "[select] (content not returned by API)");
assert.equal(renderContent({ type: 1, content: "{@:ALL,4}@ALL hi" }), "@ALL hi");
assert.equal(renderContent({ type: 1, content: "{@:1426865334056386560,10}@Shivankar さん {@:1426865410711486464,6}@Abhay さん\nOK?" }), "@Shivankar さん @Abhay さん\nOK?");
assert.equal(renderContent({ type: 5, content: { text: "hi", files: [{ name: "a.pdf", key: "attachments/x/y" }] } }), "hi [file a.pdf key=attachments/x/y]");
console.log("offline asserts ok");

if (!process.env.DIRECT4B_TOKEN && !existsSync(join(homedir(), ".direct4b", "token.json"))) {
  console.log("no token, skipping live test");
  process.exit(0);
}
const client = new Client({ name: "test", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] }));
const tools = (await client.listTools()).tools.map((t) => t.name);
console.log("tools:", tools.join(", "));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  assert.ok(!r.isError, `${name} failed: ${r.content[0].text}`);
  return r.content[0].text;
};
// Print shapes only: real chat content must not end up in logs.
const me = JSON.parse(await call("whoami"));
console.log(`whoami: user ${me.user_id}, ${me.domains.length} domain(s)`);
const talks = JSON.parse(await call("list_talks"));
console.log(`list_talks: ${talks.length} talks`);
const msgs = await call("read_messages", { talk_id: talks[0].talk_id, since: "7d", count: 5 });
assert.match(msgs, /^Talk: |^No messages/);
console.log(`read_messages: ${msgs.split("\n").length} lines`);
const mentions = await call("find_mentions", { since: "3d", limit: 5 });
assert.ok(!mentions.includes("{@:"), "mention markers should be stripped");
console.log(`find_mentions: ${mentions.startsWith("[") ? JSON.parse(mentions).length + " found" : mentions}`);
await client.close();
console.log("live smoke test ok");

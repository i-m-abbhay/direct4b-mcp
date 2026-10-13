#!/usr/bin/env node
// direct4b MCP server. `direct4b-mcp login` gets a token; no args runs the stdio server.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, basename, resolve } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = join(homedir(), ".direct4b");
const BASE = "https://restapi.direct4b.com/albero-app-server";
const SCOPES = "openid offline_access permanent_token talks messages files user.read direct.users.me.readonly domains.read";
// Message IDs are snowflakes: (ms since this epoch) << 22.
const ID_EPOCH_MS = 1343746800000n;

// ---------- config ----------

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l.includes("=")).map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
  );
}

function token(): string {
  if (process.env.DIRECT4B_TOKEN) return process.env.DIRECT4B_TOKEN;
  const f = join(DIR, "token.json");
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8")).access_token;
  throw new Error("No direct4b token. Run `npx direct4b-mcp login` or set DIRECT4B_TOKEN.");
}

// ---------- API client ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// int64 IDs exceed JS number precision, so request bodies carry them as raw digits.
const rawIds = (body: string, ids: Record<string, string | string[]>) =>
  Object.entries(ids).reduce(
    (s, [k, v]) => s.replace(`"${k}":"__${k}__"`, `"${k}":${Array.isArray(v) ? `[${v.join(",")}]` : v}`),
    body,
  );

async function api(method: string, path: string, body?: { json?: string; form?: URLSearchParams | FormData }): Promise<any> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token()}` };
  if (body?.json) headers["Content-Type"] = "application/json; charset=UTF-8";
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, { method, headers, body: body?.json ?? body?.form });
    // ponytail: fixed backoff, direct4b doesn't document limits (observed ~10 reads/burst, 24 sends/2min)
    if (res.status === 429 && attempt < 3) {
      await sleep((Number(res.headers.get("retry-after")) || 15) * 1000);
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      const why = res.headers.get("www-authenticate")?.includes("insufficient_scope")
        ? " (token lacks the scope; re-run `direct4b-mcp login`)" : "";
      throw new Error(`direct4b ${method} ${path} -> ${res.status}${why} ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : null;
  }
}

// ---------- helpers ----------

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 1) }],
});

/** "30m" | "2h" | "3d" | ISO date -> snowflake id string usable as since_id. */
export function sinceToId(since: string, now = Date.now()): string {
  const m = since.match(/^(\d+)\s*([mhd])$/);
  const ms = m ? now - Number(m[1]) * { m: 60e3, h: 3600e3, d: 86400e3 }[m[2] as "m" | "h" | "d"] : Date.parse(since);
  if (Number.isNaN(ms)) throw new Error(`Bad 'since': ${since}. Use 30m, 2h, 3d or an ISO date.`);
  return ((BigInt(ms) - ID_EPOCH_MS) << 22n).toString();
}

function talkName(t: any, meId?: string): string {
  if (t.name) return t.name;
  const others = (t.users ?? []).filter((u: any) => u.user_id_str !== meId).map((u: any) => u.name);
  return t.type === "pair" ? `DM: ${others.join(", ")}` : `(unnamed ${t.type})`;
}

const ACTION_LABEL: Record<number, string> = { 500: "yes/no", 502: "select", 504: "task" };

// Mentions are stored as `{@:<user_id>,<name length>}@Name`; the visible `@Name` follows the marker.
const MENTION = /\{@:(\d+|ALL),\d+\}/g;
export const cleanMentions = (s: string) => s.replace(MENTION, "");
const rawText = (m: any): string => (typeof m.content === "string" ? m.content : m.content?.text ?? "");

export function renderContent(m: any): string {
  const c = m.content;
  // The list API omits content for action messages (yes/no, select, task).
  if (c == null) return `[${ACTION_LABEL[m.type] ?? `type ${m.type}`}] (content not returned by API)`;
  switch (m.type) {
    case 1: return cleanMentions(c);
    case 2: return `[stamp]${c.text ? " " + cleanMentions(c.text) : ""}`;
    case 4: return `[file ${c.name} key=${c.key}]`;
    case 5: return `${cleanMentions(c.text ?? "")} ${(c.files ?? []).map((f: any) => `[file ${f.name} key=${f.key}]`).join(" ")}`.trim();
    case 7: return "[deleted]";
    case 500: return `[yes/no] ${c.question}`;
    case 502: return `[select] ${c.question} options=${JSON.stringify(c.options)}`;
    case 504: return `[task] ${c.title}`;
    default: return `[type ${m.type}] ${JSON.stringify(c)}`;
  }
}

// ---------- server ----------

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const server = new McpServer({ name: "direct4b", version });
const READ = { readOnlyHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const id = z.string().regex(/^\d+$/, "numeric id string");

server.registerTool("whoami", {
  description: "Current direct4b user, unread message count and organizations (domain_id needed to create talks).",
  annotations: READ,
}, async () => {
  const [me, unread, domains] = await Promise.all([api("GET", "/users/me"), api("GET", "/users/me/unread_message_count"), api("GET", "/domains")]);
  return ok({
    user_id: me.user_id_str, name: me.display_name, email: me.email, unread: unread.count,
    domains: domains.map((d: any) => ({ domain_id: d.domain_id_str, name: d.domain_name, role: d.role?.name })),
  });
});

server.registerTool("list_talks", {
  description: "List the user's talks (group chats and DMs) with talk_id. Filter by talk name or member name with `query`.",
  inputSchema: { query: z.string().optional().describe("Case-insensitive match on talk name or member name") },
  annotations: READ,
}, async ({ query }) => {
  const [talks, me] = await Promise.all([api("GET", "/talks"), api("GET", "/users/me")]);
  const q = query?.toLowerCase();
  const rows = talks
    .map((t: any) => ({
      talk_id: t.talk_id_str, type: t.type, name: talkName(t, me.user_id_str),
      members: (t.users ?? []).length, updated_at: t.updated_at_str,
      _match: [t.name, ...(t.users ?? []).map((u: any) => u.name)].join(" ").toLowerCase(),
    }))
    .filter((r: any) => !q || r._match.includes(q))
    .sort((a: any, b: any) => b.updated_at.localeCompare(a.updated_at))
    .map(({ _match, ...r }: any) => r);
  return ok(rows);
});

server.registerTool("find_user", {
  description: "Find users by name across all talks the current user is in. Returns user_id for create_group_talk / add_talk_members / create_pair_talk.",
  inputSchema: { query: z.string().describe("Part of the user's name or kana") },
  annotations: READ,
}, async ({ query }) => {
  const q = query.toLowerCase();
  const users = new Map<string, any>();
  for (const t of await api("GET", "/talks"))
    for (const u of t.users ?? [])
      if (`${u.name} ${u.kana ?? ""}`.toLowerCase().includes(q)) users.set(u.user_id_str, { user_id: u.user_id_str, name: u.name, kana: u.kana });
  return ok([...users.values()]);
});

server.registerTool("read_messages", {
  description:
    "Read messages in a talk, oldest first. Defaults to the last 24h. Use `since` for a time window, or `since_id` (exclusive) to page forward from the last message_id you saw.",
  inputSchema: {
    talk_id: id,
    since: z.string().optional().describe('Relative ("30m", "2h", "7d") or ISO date. Default "1d".'),
    since_id: id.optional().describe("Return messages after this message_id. Overrides `since`."),
    count: z.number().int().min(1).max(200).optional().describe("Max messages (default 50)"),
  },
  annotations: READ,
}, async ({ talk_id, since, since_id, count }) => {
  const after = since_id ?? sinceToId(since ?? "1d");
  const [talk, msgs] = await Promise.all([
    api("GET", `/talks/${talk_id}`),
    api("GET", `/talks/${talk_id}/messages?since_id=${after}&count=${count ?? 50}`),
  ]);
  const names = new Map((talk.users ?? []).map((u: any) => [u.user_id_str, u.name]));
  if (!msgs.length) return ok(`No messages in "${talkName(talk)}" after that point.`);
  const lines = msgs.map((m: any) => `${m.created_at_str} ${names.get(m.user_id_str) ?? m.user_id_str} (${m.message_id_str}): ${renderContent(m)}`);
  return ok(`Talk: ${talkName(talk)}\n${lines.join("\n")}\n\nlast message_id: ${msgs.at(-1).message_id_str}`);
});

server.registerTool("find_mentions", {
  description: "Find messages that @mention the current user (or another user), including @ALL, across all talks, newest first. Scans only talks with activity in the window.",
  inputSchema: {
    since: z.string().optional().describe('Relative ("2h", "3d") or ISO date. Default "3d".'),
    user_id: id.optional().describe("Whose mentions to find. Default: current user"),
    limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)"),
  },
  annotations: READ,
}, async ({ since, user_id, limit }) => {
  const after = sinceToId(since ?? "3d");
  const [talks, me] = await Promise.all([api("GET", "/talks"), api("GET", "/users/me")]);
  const target = user_id ?? me.user_id_str;
  const active = talks.filter((t: any) => BigInt(t.max_message_id_str ?? 0) > BigInt(after));
  const hits: any[] = [];
  // Sequential on purpose: the read rate limit is ~10 rapid calls, api() backs off on 429.
  // ponytail: 200 messages per talk; a talk busier than that in the window loses its oldest mentions.
  for (const t of active) {
    const names = new Map((t.users ?? []).map((u: any) => [u.user_id_str, u.name]));
    for (const m of await api("GET", `/talks/${t.talk_id_str}/messages?since_id=${after}&count=200`)) {
      if (m.user_id_str !== target && [...rawText(m).matchAll(MENTION)].some((x) => x[1] === target || x[1] === "ALL"))
        hits.push({
          time: m.created_at_str, talk: talkName(t, me.user_id_str), talk_id: t.talk_id_str,
          from: names.get(m.user_id_str) ?? m.user_id_str, message_id: m.message_id_str, text: renderContent(m),
        });
    }
  }
  hits.sort((a, b) => b.time.localeCompare(a.time));
  return ok(hits.length ? hits.slice(0, limit ?? 20) : `No mentions in ${active.length} active talks since ${since ?? "3d"}.`);
});

server.registerTool("send_message", {
  description: "Post a text message to a talk. Confirm the destination talk and exact text with the user before calling.",
  inputSchema: { talk_id: id, text: z.string().min(1) },
  annotations: WRITE,
}, async ({ talk_id, text }) => {
  const m = await api("POST", `/talks/${talk_id}/messages`, { json: JSON.stringify({ type: 1, content: text }) });
  return ok({ sent: true, message_id: m.message_id_str });
});

server.registerTool("send_action", {
  description: "Post an interactive message: a yes/no question, a multiple-choice select (max 9 options), or a task. Confirm with the user before calling.",
  inputSchema: {
    talk_id: id,
    kind: z.enum(["yesno", "select", "task"]),
    text: z.string().min(1).describe("Question (yesno/select) or task title (task)"),
    options: z.array(z.string()).min(2).max(9).optional().describe("Required for select"),
    close_when: z.enum(["all", "any"]).optional().describe("Done when everyone responds (default) or anyone does"),
  },
  annotations: WRITE,
}, async ({ talk_id, kind, text, options, close_when }) => {
  if (kind === "select" && !options) throw new Error("select needs options");
  const closing_type = close_when === "any" ? 0 : 1;
  const [type, content] =
    kind === "yesno" ? [500, { question: text, closing_type }]
    : kind === "select" ? [502, { question: text, options, closing_type }]
    : [504, { title: text, closing_type }];
  const m = await api("POST", `/talks/${talk_id}/messages`, { json: JSON.stringify({ type, content }) });
  return ok({ sent: true, message_id: m.message_id_str });
});

server.registerTool("send_file", {
  description: "Upload a local file to a talk, with optional text. Confirm with the user before calling.",
  inputSchema: {
    talk_id: id,
    path: z.string().describe("Absolute path to a local file"),
    text: z.string().optional(),
    content_type: z.string().optional().describe("MIME type, default application/octet-stream"),
  },
  annotations: WRITE,
}, async ({ talk_id, path, text, content_type }) => {
  const type = content_type ?? "application/octet-stream";
  const form = new FormData();
  form.append("name", basename(path));
  form.append("content_type", type);
  form.append("file", new Blob([readFileSync(path)], { type }), basename(path));
  if (text) form.append("text", text);
  const m = await api("POST", `/talks/${talk_id}/messages/files`, { form });
  return ok({ sent: true, message_id: m.message_id_str });
});

server.registerTool("download_attachment", {
  description: "Download a message attachment by its file key (shown as key=attachments/... in read_messages) to a local folder.",
  inputSchema: {
    key: z.string().regex(/^attachments\/[^/]+\/[^/]+$/),
    name: z.string().describe("File name to save as"),
    save_dir: z.string().optional().describe("Default: current directory"),
    message_id: id.optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
}, async ({ key, name, save_dir, message_id }) => {
  // fetch drops the Authorization header on the cross-origin redirect to S3.
  const res = await fetch(`${BASE}/files/${key}${message_id ? `?message_id=${message_id}` : ""}`, {
    headers: { Authorization: `Bearer ${token()}` },
  });
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const out = resolve(save_dir ?? ".", basename(name));
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  return ok({ saved: out });
});

server.registerTool("create_group_talk", {
  description:
    "Create a group talk. Get domain_id from whoami and user_ids from find_user. Do not include the current user's own id (they are added automatically; the API rejects it). Confirm with the user before calling.",
  inputSchema: {
    domain_id: id,
    name: z.string().min(1),
    user_ids: z.array(id).min(1),
    show_past_messages: z.boolean().optional().describe("Let later joiners see earlier messages (default true)"),
  },
  annotations: WRITE,
}, async ({ domain_id, name, user_ids, show_past_messages }) => {
  const json = rawIds(
    JSON.stringify({ domain_id: "__domain_id__", user_ids: "__user_ids__", name, past_message: show_past_messages ?? true }),
    { domain_id, user_ids },
  );
  const t = await api("POST", "/talks/group", { json });
  return ok({ talk_id: t.talk_id_str, name: t.name });
});

server.registerTool("create_pair_talk", {
  description: "Open (or get the existing) DM with a user, by user_id or email. Returns talk_id.",
  inputSchema: { domain_id: id, user_id: id.optional(), email: z.string().email().optional() },
  annotations: WRITE,
}, async ({ domain_id, user_id, email }) => {
  if (!user_id === !email) throw new Error("Give exactly one of user_id or email");
  const form = new URLSearchParams({ domain_id, ...(user_id ? { user_id } : { email: email! }) });
  const t = await api("POST", "/talks/pair", { form });
  return ok({ talk_id: t.talk_id_str, name: talkName(t) });
});

server.registerTool("add_talk_members", {
  description: "Add users (max 50) to a group talk. Users already in the talk are skipped (not listed in `added`). Confirm with the user before calling.",
  inputSchema: { talk_id: id, user_ids: z.array(id).min(1).max(50) },
  annotations: WRITE,
}, async ({ talk_id, user_ids }) => {
  const r = await api("PUT", `/talks/${talk_id}/members`, { json: rawIds(JSON.stringify({ user_ids: "__user_ids__" }), { user_ids }) });
  return ok({ added: (r.added_users ?? []).map((u: any) => u.name) });
});

server.registerTool("leave_talk", {
  description: "Leave a talk. Cannot be undone by the user alone. Always confirm with the user first.",
  inputSchema: { talk_id: id },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}, async ({ talk_id }) => {
  await api("DELETE", `/talks/${talk_id}/members/self`);
  return ok({ left: talk_id });
});

// ---------- login ----------

async function openBrowser(url: string) {
  const { spawn } = await import("node:child_process");
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

// First run: walk the user through registering their own direct app, then save its credentials.
async function askClientCredentials(redirect: string) {
  const { createInterface } = await import("node:readline/promises");
  console.error(`
No direct app credentials yet. Register your own app (one time):
  1. Open https://direct4b.com/applications (logged in to direct)
  2. Register a new application:
       Application name : anything, e.g. "direct4b-mcp (<your name>)"
       Site URL         : ${redirect}
       Redirect URL     : ${redirect}
  3. Paste the Client ID and Client Secret shown after registering.
  Guide with screenshots: https://github.com/i-m-abbhay/direct4b-mcp/blob/main/docs/SETUP.md
`);
  await openBrowser("https://direct4b.com/applications");
  // Line iterator instead of rl.question: question() drops lines that arrive before it's asked (piped input).
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (q: string) => { process.stderr.write(q); return String((await lines.next()).value ?? "").trim(); };
  const id = await ask("Client ID: ");
  const secret = await ask("Client Secret: ");
  rl.close();
  if (!id || !secret) { console.error("Both are required."); process.exit(1); }
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, "client.env"), `DIRECT4B_CLIENT_ID=${id}\nDIRECT4B_CLIENT_SECRET=${secret}\n`, { mode: 0o600 });
  console.error(`Saved to ${join(DIR, "client.env")}\n`);
  return { DIRECT4B_CLIENT_ID: id, DIRECT4B_CLIENT_SECRET: secret };
}

async function login() {
  let env: Record<string, string | undefined> = { ...readEnvFile(join(DIR, "client.env")), ...process.env };
  const redirect = env.DIRECT4B_REDIRECT_URI ?? "http://127.0.0.1:8080/";
  if (!env.DIRECT4B_CLIENT_ID || !env.DIRECT4B_CLIENT_SECRET) env = { ...env, ...(await askClientCredentials(redirect)) };
  const cid = env.DIRECT4B_CLIENT_ID!, secret = env.DIRECT4B_CLIENT_SECRET!;
  const state = randomBytes(16).toString("hex");
  const authUrl = "https://direct4b.com/oauth2/authorize?" + new URLSearchParams({
    response_type: "code", client_id: cid, redirect_uri: redirect, scope: SCOPES, state, prompt: "consent",
  });
  const port = Number(new URL(redirect).port || 80);

  const srv = createServer(async (req, res) => {
    const q = new URL(req.url!, redirect).searchParams;
    const reply = (code: number, msg: string) => { res.writeHead(code, { "Content-Type": "text/html; charset=utf-8" }); res.end(msg); };
    if (q.get("error")) return reply(400, `direct4b returned an error: ${q.get("error")} ${q.get("error_description") ?? ""}`);
    if (!q.get("code")) { res.writeHead(302, { Location: authUrl }); return res.end(); }
    if (q.get("state") !== state) return reply(400, "State mismatch. Start again from " + redirect);
    const r = await fetch("https://direct4b.com/oauth2/token", {
      method: "POST",
      body: new URLSearchParams({ grant_type: "authorization_code", code: q.get("code")!, redirect_uri: redirect, client_id: cid, client_secret: secret }),
    });
    if (!r.ok) return reply(400, `Token exchange failed: ${r.status} ${await r.text()}`);
    const tok = await r.json();
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, "token.json"), JSON.stringify(tok, null, 1), { mode: 0o600 });
    reply(200, "direct4b login done. You can close this tab.");
    console.error(`Saved token to ${join(DIR, "token.json")} (scopes: ${tok.scope})`);
    srv.close();
  });
  srv.listen(port, "127.0.0.1", () => {
    console.error(`Opening ${redirect} in your browser. Click 承認する (Approve) there.`);
    openBrowser(redirect);
  });
}

// Only run when executed directly (tests import this module for its helpers).
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  if (process.argv[2] === "login") await login();
  else if (process.argv[2]) { console.error("Usage: direct4b-mcp [login]"); process.exit(1); }
  else await server.connect(new StdioServerTransport());
}

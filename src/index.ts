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

export function renderContent(m: any): string {
  const c = m.content;
  switch (m.type) {
    case 1: return c;
    case 2: return `[stamp]${c.text ? " " + c.text : ""}`;
    case 4: return `[file ${c.name} key=${c.key}]`;
    case 5: return `${c.text ?? ""} ${(c.files ?? []).map((f: any) => `[file ${f.name} key=${f.key}]`).join(" ")}`.trim();
    case 7: return "[deleted]";
    case 500: return `[yes/no] ${c.question}`;
    case 502: return `[select] ${c.question} options=${JSON.stringify(c.options)}`;
    case 504: return `[task] ${c.title}`;
    default: return `[type ${m.type}] ${JSON.stringify(c)}`;
  }
}

// ---------- server ----------

const server = new McpServer({ name: "direct4b", version: "0.1.0" });
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
  description: "Create a group talk. Get domain_id from whoami and user_ids from find_user. Confirm with the user before calling.",
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
  description: "Add users (max 50) to a group talk. Confirm with the user before calling.",
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

async function login() {
  const env = { ...readEnvFile(join(DIR, "client.env")), ...process.env };
  const cid = env.DIRECT4B_CLIENT_ID, secret = env.DIRECT4B_CLIENT_SECRET;
  const redirect = env.DIRECT4B_REDIRECT_URI ?? "http://127.0.0.1:8080/";
  if (!cid || !secret) {
    console.error(`Set DIRECT4B_CLIENT_ID and DIRECT4B_CLIENT_SECRET (env or ${join(DIR, "client.env")}).`);
    process.exit(1);
  }
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
  srv.listen(port, "127.0.0.1", () => console.error(`Open ${redirect} in your browser and approve.`));
}

// Only run when executed directly (tests import this module for its helpers).
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  if (process.argv[2] === "login") await login();
  else if (process.argv[2]) { console.error("Usage: direct4b-mcp [login]"); process.exit(1); }
  else await server.connect(new StdioServerTransport());
}

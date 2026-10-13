# direct4b-mcp

MCP server for [direct](https://direct4b.com) (direct4b) business chat. Lets Claude Code, Cursor, etc. read and send messages in your talks.

## Tools

| Tool | What it does |
|---|---|
| `whoami` | Your user, unread count, organizations (`domain_id`) |
| `list_talks` | Your group talks and DMs, filter by name or member |
| `find_user` | Find a coworker's `user_id` by name |
| `read_messages` | Messages in a talk: last 24h by default, or `since: "2h"` / ISO date / `since_id` |
| `send_message` | Post text |
| `send_action` | Post a yes/no question, multiple-choice select, or task |
| `send_file` | Upload a local file |
| `download_attachment` | Save an attachment locally |
| `create_group_talk`, `create_pair_talk`, `add_talk_members`, `leave_talk` | Manage talks |

## Setup

1. **Get the app credentials** (Client ID + Client Secret) from whoever registered the company's direct app at <https://direct4b.com/applications>. The app's redirect URL must be `http://127.0.0.1:8080/`.
2. **Save them** in `~/.direct4b/client.env`:
   ```
   DIRECT4B_CLIENT_ID=...
   DIRECT4B_CLIENT_SECRET=...
   ```
3. **Log in** (opens direct's approval page; saves a non-expiring token to `~/.direct4b/token.json`):
   ```
   npx direct4b-mcp login
   ```
   Then open <http://127.0.0.1:8080/> and click 承認する.
4. **Add to Claude Code**:
   ```
   claude mcp add direct4b --scope user -- npx -y direct4b-mcp
   ```
   Cursor: add to `~/.cursor/mcp.json`:
   ```json
   { "mcpServers": { "direct4b": { "command": "npx", "args": ["-y", "direct4b-mcp"] } } }
   ```

Alternatively, skip `login` and set `DIRECT4B_TOKEN` in the MCP config's `env`.

## Notes

- Message history (`GET /talks/{id}/messages`) isn't in direct's 2022 public spec but works with the `messages` scope. Params: `since_id`, `max_id`, `count`; always oldest-first.
- Message IDs are snowflakes: `(ms - 1343746800000) << 22`, which is how `since: "2h"` works in one request.
- Rate limits are undocumented (~10 rapid reads, 24 sends / 2 min). The server waits and retries on 429.
- Admin APIs (`/rest/1/...`: members, departments, export) are not exposed.

## Develop

```
npm install
npm test   # builds, runs offline asserts, then a read-only live check if you're logged in
```

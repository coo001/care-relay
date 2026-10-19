# Care Relay

A shared care log for families, for Alexa+. Care Relay is a **self-hosted MCP server** (MCP spec **2025-11-25**, **Streamable HTTP**) with an **MCP Apps** card, plus a simulated Alexa+ web console to try it.

When several people look after one person at home, they need to know what was already done. Care Relay answers "Did anyone give Mom her evening pills?", refuses to log the same dose twice, keeps notes for the next shift, and builds a hand-off when someone leaves.

> **Alexa+ track, simulated-experience path.** This repo does not run on an Alexa+ device. The MCP server is real and works with any MCP client; the Alexa+ side is a simulated web console in `simulator/` (rule-based planner, no LLM).
>
> Care Relay only records what the family logs. It does not give medical or dosing advice.

## Run it

Requires Node.js 20+.

```bash
npm install
npm start                     # MCP: http://127.0.0.1:3333/mcp   console: http://127.0.0.1:3333/
node bin/demo-seed.js         # optional: sample plan and a day of entries, sent as real MCP tool calls
npm test                      # 11 tests (unit + end-to-end over Streamable HTTP)
```

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `3333` / `127.0.0.1` | Listen address |
| `CARE_RELAY_DATA` | `data/care-relay.json` | Where the shared state is saved |
| `CARE_RELAY_CLOCK` | (real time) | Demo only: start the clock at a fixed local time, e.g. `2026-10-20T19:44`. Enables `POST /agent/clock` to skip ahead. |
| `CARE_RELAY_NO_SIMULATOR` | unset | Set to `1` to serve only `/mcp` |

Demo video setup: `CARE_RELAY_CLOCK=2026-10-20T19:44:00 npm start`, then `node bin/demo-seed.js http://127.0.0.1:3333/mcp 2026-10-20`.

### Use it from any MCP client

Point a client that supports Streamable HTTP at `http://127.0.0.1:3333/mcp`. The server is stateless per request (no session id); all state lives in the data file, so it survives restarts and new sessions.

## What the server exposes

| Kind | Name | What it does |
| --- | --- | --- |
| Tool | `set_care_plan` | Replace the daily plan (name, kind, times, slot window, instruction) |
| Tool | `log_care` | Log a dose, meal, water, symptom, note or appointment. Matches planned items to a time slot. A second entry for the same slot returns `possible_duplicate` and is not saved unless `confirmDuplicate: true`. |
| Tool | `check_status` | Every planned slot today: `done` (who, when), `due`, `overdue`, `upcoming`. Has a UI card. |
| Tool | `shift_handoff` | Everything since the last hand-off: open/overdue items, flagged notes, what was done, what is next. Records the hand-off. Has a UI card. |
| Tool (app-only) | `mark_done_from_card` | Called by the card's "Mark done" button. `_meta.ui.visibility: ["app"]`, so hosts hide it from the model. |
| Resource | `ui://care-relay/card.html` | MCP Apps view, `text/html;profile=mcp-app` |
| Resource | `care://plan` | Current plan and family members (JSON) |
| Prompt | `start_shift` | "I'm starting my shift" -> hand-off for that person |

All tools declare `outputSchema` and return `structuredContent`.

## The simulated Alexa+ console

`simulator/` is a small host that shows the experience end to end:

- `simulator/agent.js` is a real MCP client (`@modelcontextprotocol/sdk`, `StreamableHTTPClientTransport`) that advertises the `io.modelcontextprotocol/ui` extension. A **rule-based planner** turns one request into a chain of tool calls (for example "I'm heading out, hand off to Jun" -> `shift_handoff`; "Mom had dinner and her evening pills" -> two `log_care` calls). It stops the chain and asks the user when `log_care` returns `possible_duplicate`. No LLM key is needed, so the demo is reproducible.
- `simulator/web/` is the screen: speaker picker, text or browser speech input, reply, MCP traffic log, and an MCP Apps host bridge that renders the card in a sandboxed iframe (`ui/initialize`, `ui/notifications/tool-input`, `ui/notifications/tool-result`, `ui/notifications/size-changed`, and `tools/call` from the view).
- In the demo the speaker is chosen in the console. A real Alexa+ deployment would get the person from the device.

## Project layout

```
server/store.js     state, slot matching, duplicate guard, hand-off (pure logic + JSON persistence)
server/mcp.js       MCP tools, resources, prompt
server/http.js      Streamable HTTP endpoint /mcp + console routes
ui/card.html        MCP Apps view (status and hand-off card)
simulator/          simulated Alexa+ agent and web console
bin/start.js        entry point
bin/demo-seed.js    sample plan and entries via MCP
test/               node:test suites
```

## Limits

- Simulated Alexa+ host and rule-based planner; not deployed to an Alexa+ device.
- No authentication yet. Run it on localhost or behind HTTPS with auth before sharing.
- One household per data file. Times use the server's local time zone.

## License

MIT. See [LICENSE](LICENSE).

## How it was built

Built during the hackathon (started 2026-10-18) with the help of an AI coding agent (Claude).

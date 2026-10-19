#!/usr/bin/env node
// Start Care Relay: MCP server at /mcp (Streamable HTTP) and the simulated Alexa+ console at /.
// Env: PORT (3333), HOST (127.0.0.1), CARE_RELAY_DATA (data/care-relay.json),
//      CARE_RELAY_CLOCK (optional local start time, e.g. 2026-10-20T19:40, for reproducible demos; time still moves forward),
//      CARE_RELAY_NO_SIMULATOR=1 to serve only /mcp.
import { fileURLToPath } from 'node:url';
import { CareStore } from '../server/store.js';
import { startHttp } from '../server/http.js';

const startAt = process.env.CARE_RELAY_CLOCK ? new Date(process.env.CARE_RELAY_CLOCK) : null;
const boot = Date.now();
let skew = 0; // demo only: minutes skipped with POST /agent/clock
const now = startAt ? () => new Date(startAt.getTime() + (Date.now() - boot) + skew) : () => new Date();
now.advance = startAt ? (min) => { skew += min * 60000; } : null;
const store = new CareStore({ file: process.env.CARE_RELAY_DATA || fileURLToPath(new URL('../data/care-relay.json', import.meta.url)), now });
const { url } = await startHttp({ store, port: Number(process.env.PORT || 3333), host: process.env.HOST || '127.0.0.1', simulator: !process.env.CARE_RELAY_NO_SIMULATOR });
console.log(`Care Relay MCP server: ${url}/mcp`);
if (!process.env.CARE_RELAY_NO_SIMULATOR) console.log(`Simulated Alexa+ console: ${url}/`);

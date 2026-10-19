#!/usr/bin/env node
// Seed a sample day through the MCP server itself (real tools/call over Streamable HTTP).
// Usage: node bin/demo-seed.js [http://127.0.0.1:3333/mcp] [YYYY-MM-DD]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SAMPLE_PLAN } from '../simulator/agent.js';

const url = process.argv[2] || 'http://127.0.0.1:3333/mcp';
const day = process.argv[3] || new Date().toISOString().slice(0, 10);
const c = new Client({ name: 'demo-seed', version: '0.1.0' });
await c.connect(new StreamableHTTPClientTransport(new URL(url)));
const call = async (name, args) => console.log((await c.callTool({ name, arguments: args })).content[0].text);
await call('set_care_plan', SAMPLE_PLAN);
await call('log_care', { kind: 'medication', item: 'morning pills', by: 'Ben', at: `${day}T08:10:00` });
await call('log_care', { kind: 'meal', item: 'lunch', by: 'Ben', at: `${day}T12:45:00`, details: 'ate most of it' });
await call('log_care', { kind: 'hydration', item: 'afternoon water check', by: 'Ben', at: `${day}T15:05:00` });
await call('log_care', { kind: 'appointment', item: 'clinic call', by: 'Ben', at: `${day}T16:20:00`, details: 'Clinic called: Thursday check-up moved to 10 AM', forNext: true });
await call('log_care', { kind: 'meal', item: 'dinner', by: 'Ava', at: `${day}T18:40:00` });
await c.close();

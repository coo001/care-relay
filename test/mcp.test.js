// End-to-end over real Streamable HTTP with the official MCP TypeScript SDK client.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CareStore } from '../server/store.js';
import { startHttp } from '../server/http.js';
import { UI_URI, UI_MIME } from '../server/mcp.js';
import { Agent, SAMPLE_PLAN } from '../simulator/agent.js';

let t = new Date('2026-10-20T19:50:00').getTime();
const now = () => new Date(t);
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'care-mcp-')), 'state.json');
let app, client;

before(async () => {
  app = await startHttp({ store: new CareStore({ file, now }), port: 0 });
  client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(app.url + '/mcp')));
});
after(async () => { await client.close(); await app.close(); });

test('negotiates MCP protocol 2025-11-25 over Streamable HTTP', async () => {
  // The initialize response is validated by the SDK; check the version the client ended up with.
  const res = await fetch(app.url + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } }),
  });
  const body = await res.json();
  assert.equal(body.result.protocolVersion, '2025-11-25');
  assert.equal(body.result.serverInfo.name, 'care-relay');
  assert.equal(client.transport.protocolVersion ?? '2025-11-25', '2025-11-25');
});

test('lists tools with MCP Apps metadata and serves the ui:// resource', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((x) => x.name).sort();
  assert.deepEqual(names, ['check_status', 'log_care', 'mark_done_from_card', 'set_care_plan', 'shift_handoff']);
  assert.equal(tools.find((x) => x.name === 'shift_handoff')._meta.ui.resourceUri, UI_URI);
  assert.deepEqual(tools.find((x) => x.name === 'mark_done_from_card')._meta.ui.visibility, ['app']);
  const r = await client.readResource({ uri: UI_URI });
  assert.equal(r.contents[0].mimeType, UI_MIME);
  assert.match(r.contents[0].text, /ui\/initialize/);
});

test('tool calls return structured content and refuse a double dose', async () => {
  await client.callTool({ name: 'set_care_plan', arguments: SAMPLE_PLAN });
  const a = await client.callTool({ name: 'log_care', arguments: { kind: 'medication', item: 'evening pills', by: 'Ava' } });
  assert.equal(a.structuredContent.status, 'logged');
  t += 25 * 60000;
  const b = await client.callTool({ name: 'log_care', arguments: { kind: 'medication', item: 'evening pills', by: 'Ben' } });
  assert.equal(b.structuredContent.status, 'possible_duplicate');
  assert.equal(b.structuredContent.priorBy, 'Ava');
  const st = await client.callTool({ name: 'check_status', arguments: { item: 'evening pills' } });
  assert.equal(st.structuredContent.rows[0].state, 'done');
});

test('simulated Alexa+ agent chains tools and pauses on a possible duplicate', async () => {
  const agent = await Agent.connect(app.url + '/mcp');
  assert.ok(!agent.modelTools().some((x) => x.name === 'mark_done_from_card'), 'app-only tool hidden from the model');
  const dup = await agent.handle('I just gave Mom her evening pills', 'Ben');
  assert.equal(dup.awaitingConfirmation, true);
  assert.match(dup.reply, /Ava already logged evening pills/);
  const no = await agent.handle('No', 'Ben');
  assert.match(no.reply, /did not log/);
  const note = await agent.handle('Heads up, Mom said she felt dizzy after dinner', 'Ava');
  assert.equal(note.calls[0].args.kind, 'symptom');
  t = new Date('2026-10-20T21:35:00').getTime();
  const out = await agent.handle("I'm heading out, hand off to Jun", 'Ava');
  assert.equal(out.calls.at(-1).tool, 'shift_handoff');
  assert.equal(out.ui.uri, UI_URI);
  assert.match(out.reply, /eye drops/);
  const viaApp = await agent.callFromApp('mark_done_from_card', { itemId: 'p6', by: 'Jun' });
  assert.match(viaApp.content[0].text, /Logged eye drops by Jun/);
  const blocked = await agent.callFromApp('nope', {});
  assert.equal(blocked.isError, true);
  await agent.close();
});

test('state survives a server restart (new process, same data file)', async () => {
  const app2 = await startHttp({ store: new CareStore({ file, now }), port: 0, simulator: false });
  const c2 = new Client({ name: 'test2', version: '1' });
  await c2.connect(new StreamableHTTPClientTransport(new URL(app2.url + '/mcp')));
  const st = await c2.callTool({ name: 'check_status', arguments: { item: 'eye drops' } });
  assert.equal(st.structuredContent.rows[0].by, 'Jun');
  await c2.close(); await app2.close();
});

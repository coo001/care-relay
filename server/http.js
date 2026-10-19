// HTTP entry: MCP over Streamable HTTP at /mcp, plus the simulated Alexa+ console at /.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createCareRelayServer } from './mcp.js';
import { Agent } from '../simulator/agent.js';

const WEB = fileURLToPath(new URL('../simulator/web/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

/**
 * Start the server. Returns { server, url, close }.
 * @param {{store: import('./store.js').CareStore, port?: number, host?: string, simulator?: boolean}} opts
 */
export async function startHttp({ store, port = 3333, host = '127.0.0.1', simulator = true }) {
  let agent = null;
  const srv = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/mcp') {
        // Stateless Streamable HTTP: one MCP server + transport per request. State lives in the CareStore file.
        if (req.method !== 'POST') return send(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: use POST)' }, id: null });
        const body = await readJson(req);
        const mcp = createCareRelayServer(store);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => { transport.close(); mcp.close(); });
        await mcp.connect(transport);
        return await transport.handleRequest(req, res, body);
      }
      if (!simulator) return send(res, 404, { error: 'not found' });
      if (url.pathname === '/agent/say' && req.method === 'POST') {
        agent ||= await Agent.connect(`http://${host}:${srv.address().port}/mcp`);
        const { text, speaker } = await readJson(req);
        return send(res, 200, await agent.handle(text, speaker));
      }
      if (url.pathname === '/agent/app-tool' && req.method === 'POST') {
        agent ||= await Agent.connect(`http://${host}:${srv.address().port}/mcp`);
        const { name, arguments: args } = await readJson(req);
        return send(res, 200, await agent.callFromApp(name, args));
      }
      if (url.pathname === '/agent/seed' && req.method === 'POST') {
        agent ||= await Agent.connect(`http://${host}:${srv.address().port}/mcp`);
        const r = await agent.seed();
        return send(res, 200, { text: r.content?.[0]?.text });
      }
      if (url.pathname === '/agent/clock' && req.method === 'POST') {
        // Demo clock only (CARE_RELAY_CLOCK set): skip ahead so a whole evening fits in a short demo.
        if (!store.now.advance) return send(res, 400, { error: 'demo clock not enabled' });
        const { advanceMinutes } = await readJson(req);
        store.now.advance(Number(advanceMinutes) || 0);
        return send(res, 200, { now: store.now().toISOString() });
      }
      if (url.pathname === '/agent/state') return send(res, 200, { now: store.now().toISOString(), state: store.state });
      const file = path.join(WEB, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^[/\\]+/, ''));
      if (!file.startsWith(WEB) || !fs.existsSync(file)) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: String(err.message || err) });
    }
  });
  await new Promise((r) => srv.listen(port, host, r));
  const url = `http://${host}:${srv.address().port}`;
  return { server: srv, url, close: async () => { await agent?.close(); srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); } };
}

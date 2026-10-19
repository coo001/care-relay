// Simulated Alexa+ agent. A real MCP client (Streamable HTTP) that turns one spoken request
// into a chain of tool calls. The planner is rule-based (no LLM key needed) so the demo is reproducible;
// any MCP-capable agent can call the same server instead.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const MEAL = /\b(breakfast|lunch|dinner|supper|snack|meal|ate|eaten)\b/i;
const WATER = /\b(water|drank|drink|fluids?|tea)\b/i;
const SYMPTOM = /\b(dizzy|dizziness|pain|cough|fever|fell|fall|tired|nausea|confused|swollen|headache)\b/i;
const NOTE = /\b(note|heads up|let \w+ know|tell \w+|remember that|flag)\b/i;
const CHECK = /^(did|has|have|was|were|is|are)\b|\b(status|what'?s left|what is left|anything (left|due))\b/i;
const LOG = /\b(gave|given|took|taken|had|has had|served|finished|done with|just did)\b/i;
const HANDOFF_OUT = /\b(heading out|leaving|hand(ing)? ?off|signing off|going home|my shift is over)\b/i;
const HANDOFF_IN = /\b(what did i miss|catch me up|taking over|i'?m here|starting my shift|on shift)\b/i;
const YES = /^(yes|yeah|yep|correct|log it anyway|do it)\b/i;
const NO = /^(no|nope|cancel|never mind|don'?t)\b/i;

export const SAMPLE_PLAN = {
  recipient: 'Mom',
  items: [
    { name: 'morning pills', kind: 'medication', times: ['08:00'], windowMinutes: 120, instructions: 'with breakfast' },
    { name: 'lunch', kind: 'meal', times: ['12:30'], windowMinutes: 120 },
    { name: 'afternoon water check', kind: 'hydration', times: ['15:00'], windowMinutes: 120 },
    { name: 'dinner', kind: 'meal', times: ['18:30'], windowMinutes: 120 },
    { name: 'evening pills', kind: 'medication', times: ['20:00'], windowMinutes: 120, instructions: 'after dinner' },
    { name: 'eye drops', kind: 'medication', times: ['21:30'], windowMinutes: 90 },
  ],
};

const planDocName = (d) => d.recipient || 'they';
/** Natural answer for a status check. */
export function sayStatus(sc, who) {
  const rows = sc.rows;
  if (sc.matched) {
    return rows.map((r) => r.state === 'done'
      ? `Yes. ${r.by} logged ${who}'s ${r.item} at ${r.doneAt}.`
      : r.state === 'upcoming' ? `Not yet. ${r.item} ${/s$/.test(r.item) ? 'are' : 'is'} planned for ${r.timeLabel}.`
      : `No one has logged ${who}'s ${r.item} yet. ${r.state === 'overdue' ? 'It is overdue' : 'It is due now'} (planned ${r.timeLabel}).`).join(' ');
  }
  const open = rows.filter((r) => r.state === 'due' || r.state === 'overdue');
  const done = rows.filter((r) => r.state === 'done').length;
  return `${done} of ${rows.length} care items are logged today.` + (open.length ? ` Still open: ${open.map((r) => `${r.item} (${r.timeLabel})`).join(', ')}.` : ' Nothing is open right now.');
}

export class Agent {
  constructor(client) {
    this.client = client;
    this.pending = null; // a log_care call waiting for the user's yes/no
    this.tools = [];
  }

  static async connect(url) {
    const client = new Client(
      { name: 'care-relay-alexa-sim', version: '0.1.0' },
      { capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } } },
    );
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const a = new Agent(client);
    a.tools = (await client.listTools()).tools;
    return a;
  }

  close() { return this.client.close(); }

  /** Tools the model may see (MCP Apps: hide visibility:["app"]). */
  modelTools() { return this.tools.filter((t) => (t._meta?.ui?.visibility || ['model', 'app']).includes('model')); }

  async planItems() {
    const r = await this.client.readResource({ uri: 'care://plan' });
    return JSON.parse(r.contents[0].text);
  }

  /** Turn an utterance into ordered tool calls. Exported for tests. */
  plan(text, speaker, planDoc) {
    const t = text.trim();
    const steps = [];
    if (this.pending && YES.test(t)) return [{ tool: 'log_care', args: { ...this.pending, confirmDuplicate: true } }];
    if (this.pending && NO.test(t)) return [{ tool: '__cancel__' }];
    const items = planDoc.plan || [];
    const mentioned = items.filter((p) => new RegExp(`\\b${p.name.replace(/s$/, '')}s?\\b`, 'i').test(t));
    const names = (planDoc.members || []).concat(['Ava', 'Ben', 'Jun', 'Sam']);
    const toName = (t.match(/\b(?:to|for)\s+([A-Z][a-z]+)\b/) || [])[1];

    if (CHECK.test(t) && !HANDOFF_IN.test(t)) {
      return [{ tool: 'check_status', args: mentioned[0] ? { item: mentioned[0].name } : {} }];
    }
    const isNote = NOTE.test(t) || SYMPTOM.test(t);
    if (LOG.test(t) && !isNote) {
      for (const p of mentioned) steps.push({ tool: 'log_care', args: { kind: p.kind, item: p.name, by: speaker } });
      if (!mentioned.some((p) => p.kind === 'meal') && MEAL.test(t)) {
        const meal = items.find((p) => p.kind === 'meal' && new RegExp(p.name, 'i').test(t));
        if (!meal) steps.push({ tool: 'log_care', args: { kind: 'meal', item: (t.match(MEAL) || ['meal'])[0].toLowerCase(), by: speaker } });
      }
      if (!mentioned.some((p) => p.kind === 'hydration') && WATER.test(t)) steps.push({ tool: 'log_care', args: { kind: 'hydration', item: 'water', by: speaker } });
    }
    if (isNote) {
      const details = t.replace(/^(alexa,?\s*)?(please\s*)?(make a note|note|heads up|let \w+ know|tell \w+|remember)( that)?[:,]?\s*/i, '').replace(/[.]$/, '');
      steps.push({ tool: 'log_care', args: { kind: SYMPTOM.test(t) ? 'symptom' : 'note', item: SYMPTOM.test(t) ? (t.match(SYMPTOM)[0].toLowerCase()) : 'note', details, by: speaker, forNext: true } });
    }
    if (HANDOFF_OUT.test(t)) steps.push({ tool: 'shift_handoff', args: { from: speaker, ...(toName && names.includes(toName) ? { to: toName } : toName ? { to: toName } : {}) } });
    else if (HANDOFF_IN.test(t)) steps.push({ tool: 'shift_handoff', args: { to: speaker } });
    return steps;
  }

  async handle(text, speaker = 'Ava') {
    const planDoc = await this.planItems();
    const steps = this.plan(text, speaker, planDoc);
    const calls = [];
    const said = [];
    let ui = null;
    if (!steps.length) {
      return { reply: 'Sorry, I can log care ("I gave Mom her evening pills"), check it ("Did Mom get her eye drops?"), or hand off a shift ("I\'m heading out, hand off to Ben").', calls, ui };
    }
    if (steps[0].tool === '__cancel__') {
      this.pending = null;
      return { reply: 'Okay, I did not log it again.', calls, ui };
    }
    this.pending = null;
    for (const s of steps) {
      const res = await this.client.callTool({ name: s.tool, arguments: s.args });
      calls.push({ tool: s.tool, args: s.args, result: res.structuredContent, text: res.content?.[0]?.text });
      const sc = res.structuredContent || {};
      if (s.tool === 'log_care' && sc.status === 'possible_duplicate') {
        this.pending = s.args;
        said.push(`Wait. ${sc.priorBy} already logged ${sc.item} at ${sc.priorAt}. Do you still want me to log another one?`);
        break; // stop the chain; a human has to decide
      }
      if (s.tool === 'log_care') said.push(`Got it, ${sc.item} logged for ${sc.by} at ${sc.at}.`);
      else if (s.tool === 'check_status' && sc.rows?.length) said.push(sayStatus(sc, planDocName(planDoc)));
      else said.push(res.content?.[0]?.text || '');
      const tool = this.tools.find((x) => x.name === s.tool);
      const uri = tool?._meta?.ui?.resourceUri;
      if (uri) {
        const r = await this.client.readResource({ uri });
        ui = { uri, html: r.contents[0].text, mimeType: r.contents[0].mimeType, toolInput: s.args, toolResult: res };
      }
    }
    return { reply: said.join(' '), calls, ui, awaitingConfirmation: Boolean(this.pending) };
  }

  /** tools/call coming from an MCP Apps view, proxied by the host. */
  async callFromApp(name, args) {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) return { isError: true, content: [{ type: 'text', text: `Unknown tool ${name}` }] };
    const vis = tool._meta?.ui?.visibility || ['model', 'app'];
    if (!vis.includes('app')) return { isError: true, content: [{ type: 'text', text: `Tool ${name} is not callable from apps` }] };
    return this.client.callTool({ name, arguments: args });
  }

  async seed() {
    return this.client.callTool({ name: 'set_care_plan', arguments: SAMPLE_PLAN });
  }
}

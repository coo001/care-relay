// Care Relay MCP server: tools, resources, prompt, and an MCP Apps (ui://) hand-off card.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { KINDS, speakHandoff } from './store.js';

export const UI_URI = 'ui://care-relay/card.html';
export const UI_MIME = 'text/html;profile=mcp-app';
const cardHtml = () => fs.readFileSync(fileURLToPath(new URL('../ui/card.html', import.meta.url)), 'utf8');

const statusRow = z.object({
  itemId: z.string(), item: z.string(), kind: z.string(), time: z.string(), timeLabel: z.string(),
  state: z.enum(['done', 'due', 'overdue', 'upcoming']), by: z.string().nullable(), doneAt: z.string().nullable(),
  instructions: z.string(),
});

const result = (text, structuredContent) => ({ content: [{ type: 'text', text }], structuredContent });

/** Build a fresh McpServer bound to a CareStore. */
export function createCareRelayServer(store) {
  const server = new McpServer(
    { name: 'care-relay', title: 'Care Relay', version: '0.1.0' },
    {
      capabilities: { logging: {} },
      instructions:
        'Care Relay keeps a shared care log for a family looking after one person at home. ' +
        'Before saying a dose was missed or given, call check_status. When someone reports a dose, call log_care; ' +
        'if it returns possible_duplicate, read the prior entry back and ask before retrying with confirmDuplicate=true. ' +
        'Never give medical or dosing advice; only report what the family logged.',
    },
  );

  server.registerTool(
    'set_care_plan',
    {
      title: 'Set care plan',
      description: 'Replace the daily care plan (medications, meals, hydration, checks) for the person being cared for.',
      inputSchema: {
        recipient: z.string().optional().describe('Who is being cared for, e.g. "Mom"'),
        items: z.array(z.object({
          name: z.string().describe('e.g. "evening pills"'),
          kind: z.enum(KINDS),
          times: z.array(z.string().regex(/^\d{2}:\d{2}$/)).min(1).describe('24h local times, e.g. ["08:00","20:00"]'),
          windowMinutes: z.number().int().min(10).max(360).optional().describe('How far from the time an entry still counts for that slot (default 90)'),
          instructions: z.string().optional().describe('Family-written instruction, e.g. "with food"'),
        })).min(1),
      },
      outputSchema: { recipient: z.string(), itemCount: z.number() },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ recipient, items }) => {
      const plan = store.setPlan({ recipient, items });
      return result(`Care plan for ${store.state.recipient} saved: ${plan.map((p) => `${p.name} at ${p.times.join(', ')}`).join('; ')}.`, { recipient: store.state.recipient, itemCount: plan.length });
    },
  );

  server.registerTool(
    'log_care',
    {
      title: 'Log a care event',
      description: 'Record that someone gave a medication, served a meal, or noticed something. Planned items are matched to their time slot; a second entry for the same slot is refused unless confirmDuplicate is true.',
      inputSchema: {
        kind: z.enum(KINDS).describe('Type of event'),
        item: z.string().describe('Plan item name (e.g. "evening pills") or a short label'),
        by: z.string().describe('Family member who did it'),
        details: z.string().optional().describe('Free text, e.g. "ate half of dinner"'),
        forNext: z.boolean().optional().describe('Flag this so the next person sees it at hand-off'),
        at: z.string().optional().describe('ISO time if not now'),
        confirmDuplicate: z.boolean().optional().describe('Only true after the user confirmed a second entry for the same slot'),
      },
      outputSchema: {
        status: z.enum(['logged', 'possible_duplicate']),
        item: z.string(),
        by: z.string().optional(),
        at: z.string().optional(),
        priorBy: z.string().optional(),
        priorAt: z.string().optional(),
      },
    },
    async (args) => {
      const r = store.logCare(args);
      if (r.status === 'possible_duplicate') {
        const t = new Date(r.prior.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        return result(
          `Not logged. ${r.prior.by} already logged ${r.prior.item} for the ${r.slotTime} slot at ${t}. Ask the user before logging again.`,
          { status: 'possible_duplicate', item: r.prior.item, priorBy: r.prior.by, priorAt: t },
        );
      }
      const t = new Date(r.entry.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      return result(`Logged: ${r.entry.item} by ${r.entry.by} at ${t}${r.entry.forNext ? ' (flagged for next shift)' : ''}.`, { status: 'logged', item: r.entry.item, by: r.entry.by, at: t });
    },
  );

  server.registerTool(
    'check_status',
    {
      title: 'Check today\'s care status',
      description: 'Answer "did anyone give / serve X?" from the shared log. Returns every planned slot today as done, due, overdue or upcoming.',
      inputSchema: { item: z.string().optional().describe('Plan item to check; omit for everything') },
      outputSchema: { matched: z.string().nullable(), rows: z.array(statusRow), view: z.literal('status') },
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: UI_URI } },
    },
    async ({ item }) => {
      const r = store.checkStatus({ item });
      const text = r.rows.length
        ? r.rows.map((x) => (x.state === 'done' ? `${x.item} (${x.timeLabel}): given by ${x.by} at ${x.doneAt}` : `${x.item} (${x.timeLabel}): ${x.state}, not logged yet`)).join('. ') + '.'
        : item ? `"${item}" is not in the care plan.` : 'No care plan yet.';
      return result(text, { ...r, view: 'status' });
    },
  );

  server.registerTool(
    'shift_handoff',
    {
      title: 'Shift hand-off',
      description: 'Summarize everything since the last hand-off for the next caregiver: what was done, what is still open or overdue, and flagged notes. Records the hand-off so the next summary starts from here.',
      inputSchema: {
        from: z.string().optional().describe('Caregiver going off shift'),
        to: z.string().optional().describe('Caregiver coming on shift'),
      },
      outputSchema: {
        recipient: z.string(), from: z.string().nullable(), to: z.string().nullable(), sinceLabel: z.string(), atLabel: z.string(),
        done: z.array(z.object({ item: z.string(), by: z.string(), at: z.string() })),
        other: z.array(z.object({ item: z.string(), kind: z.string(), by: z.string(), at: z.string(), details: z.string() })),
        notes: z.array(z.object({ kind: z.string(), item: z.string(), details: z.string(), by: z.string(), at: z.string() })),
        open: z.array(statusRow), upcoming: z.array(statusRow), view: z.literal('handoff'),
      },
      _meta: { ui: { resourceUri: UI_URI } },
    },
    async ({ from, to }) => {
      const s = store.handoff({ from, to });
      return result(speakHandoff(s), { ...s, view: 'handoff' });
    },
  );

  // App-only tool: the card's "Mark done" button calls this through the host.
  server.registerTool(
    'mark_done_from_card',
    {
      title: 'Mark a planned item done (card button)',
      description: 'Used by the Care Relay card UI. Logs a planned item for the current slot.',
      inputSchema: { itemId: z.string(), by: z.string() },
      _meta: { ui: { resourceUri: UI_URI, visibility: ['app'] } },
    },
    async ({ itemId, by }) => {
      const p = store.state.plan.find((x) => x.id === itemId);
      if (!p) return { content: [{ type: 'text', text: 'Unknown item.' }], isError: true };
      const r = store.logCare({ kind: p.kind, item: p.name, by });
      const status = store.checkStatus({});
      const text = r.status === 'logged' ? `Logged ${p.name} by ${by}.` : `${r.prior.by} already logged ${p.name}.`;
      return result(text, { ...status, view: 'status', notice: text });
    },
  );

  server.registerResource(
    'care-relay-card',
    UI_URI,
    { title: 'Care Relay card', description: 'Interactive status / hand-off card (MCP Apps view)', mimeType: UI_MIME },
    async () => ({ contents: [{ uri: UI_URI, mimeType: UI_MIME, text: cardHtml(), _meta: { ui: { prefersBorder: true } } }] }),
  );

  server.registerResource(
    'care-plan',
    'care://plan',
    { title: 'Current care plan', mimeType: 'application/json' },
    async () => ({ contents: [{ uri: 'care://plan', mimeType: 'application/json', text: JSON.stringify({ recipient: store.state.recipient, plan: store.state.plan, members: store.state.members }, null, 2) }] }),
  );

  server.registerPrompt(
    'start_shift',
    { title: 'Start my shift', description: 'Get the hand-off for the caregiver coming on shift.', argsSchema: { name: z.string() } },
    ({ name }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `I'm ${name} and I'm starting my care shift. Call shift_handoff with to="${name}" and read me what I need to know first.` } }] }),
  );

  return server;
}

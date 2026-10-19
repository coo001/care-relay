// Care Relay state: care plan, care log, hand-offs.
// Pure logic + JSON-file persistence, so state survives across sessions and restarts.
import fs from 'node:fs';
import path from 'node:path';

export const KINDS = ['medication', 'meal', 'hydration', 'mood', 'symptom', 'note', 'appointment', 'other'];

const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export function fmtTime(d) {
  let h = d.getHours();
  const m = pad(d.getMinutes());
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}
function atTime(day, hm) {
  const [h, m] = hm.split(':').map(Number);
  const d = new Date(day);
  d.setHours(h, m, 0, 0);
  return d;
}
const norm = (s) => String(s || '').trim().toLowerCase();

export function emptyState() {
  return { recipient: 'Mom', members: [], plan: [], log: [], handoffs: [] };
}

export class CareStore {
  /**
   * @param {{file?: string, now?: () => Date}} opts
   * file: JSON path for persistence (omit for in-memory). now: injectable clock.
   */
  constructor(opts = {}) {
    this.file = opts.file || null;
    this.now = opts.now || (() => new Date());
    this.state = emptyState();
    if (this.file && fs.existsSync(this.file)) {
      this.state = { ...emptyState(), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    }
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }

  rememberMember(name) {
    const n = String(name || '').trim();
    if (n && !this.state.members.some((m) => norm(m) === norm(n))) this.state.members.push(n);
  }

  /** Replace the care plan. items: [{name, kind, times:["08:00"], windowMinutes}] */
  setPlan({ recipient, items }) {
    if (recipient) this.state.recipient = recipient;
    this.state.plan = items.map((it, i) => ({
      id: it.id || `p${i + 1}`,
      name: it.name,
      kind: KINDS.includes(it.kind) ? it.kind : 'other',
      times: [...it.times].sort(),
      windowMinutes: it.windowMinutes ?? 90,
      instructions: it.instructions || '',
    }));
    this.save();
    return this.state.plan;
  }

  findPlanItem(text) {
    const q = norm(text);
    if (!q) return null;
    return (
      this.state.plan.find((p) => norm(p.name) === q) ||
      this.state.plan.find((p) => q.includes(norm(p.name)) || norm(p.name).includes(q)) ||
      null
    );
  }

  /** Scheduled slots of a plan item for the given day. */
  slotsFor(item, day = this.now()) {
    return item.times.map((t) => ({ itemId: item.id, time: t, at: atTime(day, t), key: `${item.id}@${dayKey(day)}T${t}` }));
  }

  /** The slot a log entry at `when` belongs to (closest scheduled time within the window). */
  matchSlot(item, when) {
    let best = null;
    for (const s of this.slotsFor(item, when)) {
      const diff = Math.abs(when - s.at) / 60000;
      if (diff <= item.windowMinutes && (!best || diff < best.diff)) best = { ...s, diff };
    }
    return best;
  }

  /**
   * Log a care event. For planned items, refuses a second entry for the same slot
   * unless confirmDuplicate is true (prevents double doses between family members).
   */
  logCare({ kind = 'note', item = '', by, at, details = '', forNext = false, confirmDuplicate = false }) {
    const when = at ? new Date(at) : this.now();
    const planItem = this.findPlanItem(item) || (kind === 'medication' ? this.state.plan.find((p) => p.kind === 'medication' && this.matchSlot(p, when)) : null);
    const slot = planItem ? this.matchSlot(planItem, when) : null;
    if (slot) {
      const prior = this.state.log.find((e) => e.slotKey === slot.key && !e.voided);
      if (prior && !confirmDuplicate) {
        return { status: 'possible_duplicate', prior, planItem, slotTime: slot.time };
      }
    }
    this.rememberMember(by);
    const entry = {
      id: `e${this.state.log.length + 1}`,
      kind: planItem ? planItem.kind : KINDS.includes(kind) ? kind : 'other',
      item: planItem ? planItem.name : item || kind,
      planItemId: planItem?.id || null,
      slotKey: slot?.key || null,
      slotTime: slot?.time || null,
      by: by || 'someone',
      at: when.toISOString(),
      details,
      forNext: Boolean(forNext),
    };
    this.state.log.push(entry);
    this.save();
    return { status: 'logged', entry, planItem };
  }

  /** Status of every planned slot today: done / due / overdue / upcoming. */
  todayStatus() {
    const now = this.now();
    const rows = [];
    for (const item of this.state.plan) {
      for (const s of this.slotsFor(item, now)) {
        const done = this.state.log.find((e) => e.slotKey === s.key && !e.voided);
        const minsFromSlot = (now - s.at) / 60000;
        let state;
        if (done) state = 'done';
        else if (minsFromSlot > item.windowMinutes) state = 'overdue';
        else if (minsFromSlot >= -item.windowMinutes) state = 'due';
        else state = 'upcoming';
        rows.push({
          itemId: item.id,
          item: item.name,
          kind: item.kind,
          time: s.time,
          timeLabel: fmtTime(s.at),
          state,
          by: done?.by || null,
          doneAt: done ? fmtTime(new Date(done.at)) : null,
          instructions: item.instructions,
        });
      }
    }
    rows.sort((a, b) => a.time.localeCompare(b.time));
    return rows;
  }

  checkStatus({ item } = {}) {
    const rows = this.todayStatus();
    if (!item) return { matched: null, rows };
    const p = this.findPlanItem(item);
    return { matched: p ? p.name : null, rows: p ? rows.filter((r) => r.itemId === p.id) : [] };
  }

  lastHandoff() {
    return this.state.handoffs[this.state.handoffs.length - 1] || null;
  }

  /**
   * Build a shift hand-off: everything logged since the last hand-off (or start of day),
   * open/overdue items, and notes flagged for the next person. Records the hand-off.
   */
  handoff({ from, to, record = true } = {}) {
    const now = this.now();
    const last = this.lastHandoff();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const since = last ? new Date(last.at) : startOfDay;
    const events = this.state.log.filter((e) => new Date(e.at) > since && !e.voided);
    const status = this.todayStatus();
    const open = status.filter((r) => r.state === 'overdue' || r.state === 'due');
    const upcoming = status.filter((r) => r.state === 'upcoming').slice(0, 4);
    const notes = events.filter((e) => e.forNext || ['symptom', 'mood', 'note', 'appointment'].includes(e.kind));
    const summary = {
      recipient: this.state.recipient,
      from: from || last?.to || null,
      to: to || null,
      sinceLabel: last ? `${fmtTime(since)} (last hand-off: ${last.from || '?'} to ${last.to || '?'})` : 'start of today',
      atLabel: fmtTime(now),
      done: events.filter((e) => e.planItemId).map((e) => ({ item: e.item, by: e.by, at: fmtTime(new Date(e.at)) })),
      other: events.filter((e) => !e.planItemId && !notes.includes(e)).map((e) => ({ item: e.item, kind: e.kind, by: e.by, at: fmtTime(new Date(e.at)), details: e.details })),
      notes: notes.map((e) => ({ kind: e.kind, item: e.item, details: e.details, by: e.by, at: fmtTime(new Date(e.at)) })),
      open,
      upcoming,
    };
    if (from) this.rememberMember(from);
    if (to) this.rememberMember(to);
    if (record && (from || to)) {
      this.state.handoffs.push({ from: from || null, to: to || null, at: now.toISOString() });
      this.save();
    }
    return summary;
  }

  /** Undo a mistaken entry (kept for audit, marked voided). */
  voidEntry(id, by) {
    const e = this.state.log.find((x) => x.id === id);
    if (!e) return null;
    e.voided = { by: by || 'someone', at: this.now().toISOString() };
    this.save();
    return e;
  }
}

/** Plain-English sentence for a hand-off, for voice output. */
export function speakHandoff(s) {
  const parts = [];
  parts.push(s.done.length ? `Since ${s.sinceLabel.split(' (')[0]}: ${s.done.map((d) => `${d.item} by ${d.by} at ${d.at}`).join('; ')}.` : `Nothing from the care plan was logged since ${s.sinceLabel.split(' (')[0]}.`);
  if (s.open.length) parts.push(`Still open: ${s.open.map((r) => `${r.item} (${r.timeLabel}${r.state === 'overdue' ? ', overdue' : ''})`).join(', ')}.`);
  if (s.notes.length) parts.push(`Notes: ${s.notes.map((n) => `${n.details || n.item} (${n.by})`).join('; ')}.`);
  if (s.upcoming.length) parts.push(`Next up: ${s.upcoming.map((r) => `${r.item} at ${r.timeLabel}`).join(', ')}.`);
  return parts.join(' ');
}

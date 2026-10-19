import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CareStore, speakHandoff } from '../server/store.js';
import { SAMPLE_PLAN } from '../simulator/agent.js';

function clockAt(iso) { let t = new Date(iso).getTime(); const now = () => new Date(t); now.set = (s) => { t = new Date(s).getTime(); }; return now; }

test('slot status moves upcoming -> due -> overdue, and done when logged', () => {
  const now = clockAt('2026-10-20T17:00:00');
  const s = new CareStore({ now });
  s.setPlan(SAMPLE_PLAN);
  const ev = () => s.todayStatus().find((r) => r.item === 'evening pills').state;
  assert.equal(ev(), 'upcoming');
  now.set('2026-10-20T19:10:00'); assert.equal(ev(), 'due');
  now.set('2026-10-20T22:30:00'); assert.equal(ev(), 'overdue');
  now.set('2026-10-20T20:05:00');
  s.logCare({ kind: 'medication', item: 'evening pills', by: 'Ava' });
  assert.equal(ev(), 'done');
  const morning = s.todayStatus().find((r) => r.item === 'morning pills');
  assert.equal(morning.state, 'overdue');
});

test('second log for the same medication slot is refused until confirmed', () => {
  const now = clockAt('2026-10-20T19:50:00');
  const s = new CareStore({ now });
  s.setPlan(SAMPLE_PLAN);
  assert.equal(s.logCare({ kind: 'medication', item: 'evening pills', by: 'Ava' }).status, 'logged');
  now.set('2026-10-20T20:20:00');
  const dup = s.logCare({ kind: 'medication', item: 'evening pills', by: 'Ben' });
  assert.equal(dup.status, 'possible_duplicate');
  assert.equal(dup.prior.by, 'Ava');
  assert.equal(s.state.log.length, 1);
  assert.equal(s.logCare({ kind: 'medication', item: 'evening pills', by: 'Ben', confirmDuplicate: true }).status, 'logged');
  assert.equal(s.state.log.length, 2);
});

test('different slots of the same day do not collide', () => {
  const now = clockAt('2026-10-20T08:10:00');
  const s = new CareStore({ now });
  s.setPlan({ items: [{ name: 'pills', kind: 'medication', times: ['08:00', '20:00'], windowMinutes: 120 }] });
  assert.equal(s.logCare({ kind: 'medication', item: 'pills', by: 'Ava' }).status, 'logged');
  now.set('2026-10-20T20:00:00');
  assert.equal(s.logCare({ kind: 'medication', item: 'pills', by: 'Ava' }).status, 'logged');
  assert.deepEqual(s.state.log.map((e) => e.slotTime), ['08:00', '20:00']);
});

test('hand-off covers only what happened since the previous hand-off and keeps flagged notes', () => {
  const now = clockAt('2026-10-20T18:40:00');
  const s = new CareStore({ now });
  s.setPlan(SAMPLE_PLAN);
  s.logCare({ kind: 'meal', item: 'dinner', by: 'Ava' });
  s.handoff({ from: 'Ben', to: 'Ava' });
  now.set('2026-10-20T20:00:00');
  s.logCare({ kind: 'medication', item: 'evening pills', by: 'Ava' });
  s.logCare({ kind: 'symptom', item: 'dizzy', details: 'Mom felt dizzy after dinner', by: 'Ava', forNext: true });
  now.set('2026-10-20T21:40:00');
  const h = s.handoff({ from: 'Ava', to: 'Jun' });
  assert.deepEqual(h.done.map((d) => d.item), ['evening pills']);
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0].details, /dizzy/);
  assert.equal(h.open.find((r) => r.item === 'eye drops').state, 'due');
  assert.equal(h.open.find((r) => r.item === 'morning pills').state, 'overdue'); // never logged today
  assert.match(speakHandoff(h), /eye drops/);
  assert.equal(s.state.handoffs.length, 2);
});

test('state persists to disk and reloads (survives restarts)', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'care-')), 'state.json');
  const now = clockAt('2026-10-20T20:00:00');
  const a = new CareStore({ file, now });
  a.setPlan(SAMPLE_PLAN);
  a.logCare({ kind: 'medication', item: 'evening pills', by: 'Ava' });
  const b = new CareStore({ file, now });
  assert.equal(b.state.log.length, 1);
  assert.equal(b.logCare({ kind: 'medication', item: 'evening pills', by: 'Ben' }).status, 'possible_duplicate');
});

test('voided entries free the slot again', () => {
  const now = clockAt('2026-10-20T20:00:00');
  const s = new CareStore({ now });
  s.setPlan(SAMPLE_PLAN);
  const r = s.logCare({ kind: 'medication', item: 'evening pills', by: 'Ava' });
  s.voidEntry(r.entry.id, 'Ava');
  assert.equal(s.logCare({ kind: 'medication', item: 'evening pills', by: 'Ben' }).status, 'logged');
});

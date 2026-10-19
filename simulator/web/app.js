// Browser side of the simulated Alexa+ host: voice/text in, spoken reply out,
// and an MCP Apps host bridge for the sandboxed card iframe.
const $ = (id) => document.getElementById(id);
const SAMPLES = [
  ['Ava', 'Did Mom get her morning pills?'],
  ['Ava', 'I gave Mom her evening pills'],
  ['Ben', 'I just gave Mom her evening pills'],
  ['Ben', 'No'],
  ['Ava', 'Heads up, Mom said she felt dizzy after dinner'],
  ['Ava', "I'm heading out, hand off to Jun"],
  ['Jun', 'What did I miss?'],
];
let current = null; // { html, toolInput, toolResult }

function addLog(html) { const li = document.createElement('li'); li.innerHTML = html; $('log').appendChild(li); }
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

async function tick() {
  const r = await fetch('/agent/state').then((x) => x.json());
  $('clock').textContent = new Date(r.now).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function speak(text) {
  if (!('speechSynthesis' in window) || !document.body.dataset.voice) return;
  speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

async function say(text, speaker) {
  $('said').innerHTML = `<b>${esc(speaker)}:</b> “${esc(text)}”`;
  $('reply').textContent = '';
  $('ring').classList.add('on');
  const r = await fetch('/agent/say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, speaker }) }).then((x) => x.json());
  $('ring').classList.remove('on');
  $('reply').textContent = r.reply || r.error;
  speak(r.reply);
  for (const c of r.calls || []) {
    const warn = c.result?.status === 'possible_duplicate' ? ' <span class="w">⚠ possible_duplicate</span>' : '';
    addLog(`<span class="t">tools/call ${esc(c.tool)}</span>${warn}\n${esc(JSON.stringify(c.args))}\n→ ${esc(c.text)}`);
  }
  if (!r.ui) { $('cardwrap').hidden = true; current = null; }
  if (r.ui) {
    addLog(`<span class="t">resources/read ${esc(r.ui.uri)}</span>\nmimeType ${esc(r.ui.mimeType)} → rendered in sandboxed iframe`);
    mountCard(r.ui, speaker);
  }
  tick();
}

// ---- MCP Apps host bridge (spec 2026-01-26) ----
function mountCard(ui, speaker) {
  current = { ...ui, speaker };
  $('cardwrap').hidden = false;
  $('card').srcdoc = ui.html;
}
window.addEventListener('message', async (ev) => {
  if (ev.source !== $('card').contentWindow) return;
  const m = ev.data; if (!m || m.jsonrpc !== '2.0' || !current) return;
  const reply = (result) => ev.source.postMessage({ jsonrpc: '2.0', id: m.id, result }, '*');
  if (m.method === 'ui/initialize') {
    reply({ protocolVersion: '2026-01-26', hostInfo: { name: 'care-relay-alexa-sim', version: '0.1.0' }, hostCapabilities: { serverTools: {} }, hostContext: { theme: 'dark', displayMode: 'inline', availableDisplayModes: ['inline'], speaker: current.speaker } });
  } else if (m.method === 'ui/notifications/initialized') {
    ev.source.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: current.toolInput } }, '*');
    ev.source.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: current.toolResult }, '*');
  } else if (m.method === 'ui/notifications/size-changed') {
    $('card').style.height = Math.min(Math.max(m.params.height, 120), 460) + 'px';
  } else if (m.method === 'tools/call') {
    addLog(`<span class="t">app → tools/call ${esc(m.params.name)}</span>\n${esc(JSON.stringify(m.params.arguments))}`);
    const res = await fetch('/agent/app-tool', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(m.params) }).then((x) => x.json());
    addLog(`→ ${esc(res.content?.[0]?.text)}`);
    reply(res);
    tick();
  } else if (m.id) {
    ev.source.postMessage({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not supported by this host' } }, '*');
  }
});

// ---- input ----
$('form').addEventListener('submit', (e) => { e.preventDefault(); const t = $('text').value.trim(); if (t) { say(t, $('speaker').value); $('text').value = ''; } });
$('seed').addEventListener('click', async () => {
  const r = await fetch('/agent/seed', { method: 'POST' }).then((x) => x.json());
  addLog(`<span class="t">tools/call set_care_plan</span>\n→ ${esc(r.text)}`);
  $('reply').textContent = r.text;
});
for (const [who, text] of SAMPLES) {
  const b = document.createElement('button'); b.type = 'button'; b.textContent = `${who}: ${text}`;
  b.addEventListener('click', () => { $('speaker').value = who; say(text, who); });
  $('samples').appendChild(b);
}
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
$('mic').addEventListener('click', () => {
  if (!SR) { alert('Speech recognition is not available in this browser. Type instead.'); return; }
  const rec = new SR(); rec.lang = 'en-US';
  rec.onresult = (e) => say(e.results[0][0].transcript, $('speaker').value);
  rec.start();
});
const params = new URLSearchParams(location.search);
if (params.get('voice')) document.body.dataset.voice = '1';
if (params.get('hideSamples')) $('samples').hidden = true;
tick();
window.careRelay = { say };

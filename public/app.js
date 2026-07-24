/* deploy-gui frontend — vanilla JS, no build step. */
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let socket = null;
let appState = { apps: [], workflows: [], tunnel: null };

/* ================= helpers ================= */

async function api(path, opts = {}) {
  const res = await fetch(path, opts.body instanceof FormData
    ? opts
    : { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (res.status === 401) {
    showLogin();
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '–';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function barClass(pct) {
  if (pct >= 90) return 'bar-fill crit';
  if (pct >= 70) return 'bar-fill warn';
  return 'bar-fill';
}

/* ================= modal ================= */

const modal = { title: '', sub: null, unsub: null };

function openModal(title, { sub, unsub } = {}) {
  $('#modal-title').textContent = title;
  $('#modal-body').textContent = '';
  $('#modal-footer').textContent = '';
  modal.sub = sub || null;
  modal.unsub = unsub || null;
  if (modal.sub) modal.sub();
  $('#modal').classList.remove('hidden');
}

function closeModal() {
  if (modal.unsub) modal.unsub();
  modal.sub = modal.unsub = null;
  $('#modal').classList.add('hidden');
}

function modalAppend(text) {
  const body = $('#modal-body');
  body.textContent += text;
  body.scrollTop = body.scrollHeight;
}

$('#modal-close').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) closeModal(); });
$('#modal-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#modal-body').textContent); } catch { /* no clipboard perm */ }
});

/* ================= login ================= */

function showLogin() {
  $('#app-shell').classList.add('hidden');
  $('#login-overlay').classList.remove('hidden');
  $('#login-token').focus();
}

function showApp() {
  $('#login-overlay').classList.add('hidden');
  $('#app-shell').classList.remove('hidden');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    await api('/login', {
      method: 'POST',
      body: JSON.stringify({ token: $('#login-token').value }),
    });
    $('#login-token').value = '';
    boot();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#logout-btn').addEventListener('click', async () => {
  try { await api('/logout', { method: 'POST', body: '{}' }); } catch { /* ignore */ }
  if (socket) socket.disconnect();
  showLogin();
});

/* ================= tabs ================= */

const tabInited = {};

$$('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
    const tab = btn.dataset.tab;
    $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tab}`));
    if (!tabInited[tab]) {
      tabInited[tab] = true;
      if (tab === 'terminal') initTerminal();
      if (tab === 'settings') loadSettings();
    }
    if (tab === 'terminal' && termApi) termApi.fit();
  });
});

/* ================= dashboard ================= */

function renderHealth(h) {
  $('#cpu-val').textContent = `${h.cpuPercent.toFixed(1)}%`;
  $('#cpu-bar').className = barClass(h.cpuPercent);
  $('#cpu-bar').style.width = `${Math.min(100, h.cpuPercent)}%`;

  $('#ram-val').textContent = `${h.ram.percent.toFixed(1)}%`;
  $('#ram-sub').textContent = `${fmtBytes(h.ram.used)} / ${fmtBytes(h.ram.total)}`;
  $('#ram-bar').className = barClass(h.ram.percent);
  $('#ram-bar').style.width = `${Math.min(100, h.ram.percent)}%`;

  $('#storage-val').textContent = `${h.storage.percent.toFixed(1)}%`;
  $('#storage-sub').textContent = `${fmtBytes(h.storage.used)} / ${fmtBytes(h.storage.total)} (${h.storage.mount})`;
  $('#storage-bar').className = barClass(h.storage.percent);
  $('#storage-bar').style.width = `${Math.min(100, h.storage.percent)}%`;

  $('#uptime-val').textContent = fmtDuration(h.uptimeSec * 1000);
  $('#requests-val').textContent = String(h.requests);

  const tbody = $('#proc-table tbody');
  tbody.innerHTML = h.processes.length
    ? h.processes.map((p) =>
        `<tr><td>${p.pid}</td><td>${esc(p.name)}</td><td>${p.cpu.toFixed(1)}</td><td>${p.mem.toFixed(1)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="muted">no data</td></tr>';
}

/* ================= apps ================= */

function statusPill(s) {
  return `<span class="pill ${esc(s)}">${esc(s)}</span>`;
}

function renderApps(list) {
  appState.apps = list;
  const tbody = $('#apps-table tbody');
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">no apps yet</td></tr>';
    return;
  }
  tbody.innerHTML = list.map((a) => `
    <tr>
      <td><strong>${esc(a.name)}</strong><br><span class="muted">${esc(a.method)} · ${esc(a.command)}</span></td>
      <td>${statusPill(a.status)}</td>
      <td>${a.status === 'running' ? fmtDuration(a.uptimeMs) : '–'}</td>
      <td>${a.restarts}</td>
      <td>
        <button class="btn small" data-act="logs" data-name="${esc(a.name)}">Logs</button>
        <button class="btn small" data-act="start" data-name="${esc(a.name)}">Start</button>
        <button class="btn small" data-act="stop" data-name="${esc(a.name)}">Stop</button>
        <button class="btn small" data-act="restart" data-name="${esc(a.name)}">Restart</button>
        <button class="btn small danger" data-act="delete" data-name="${esc(a.name)}">Delete</button>
      </td>
    </tr>`).join('');
}

$('#apps-table').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const name = btn.dataset.name;
  const act = btn.dataset.act;
  try {
    if (act === 'logs') {
      openModal(`Logs — ${name}`, {
        sub: () => socket.emit('app:subscribe', name),
        unsub: () => socket.emit('app:unsubscribe', name),
      });
    } else if (act === 'delete') {
      if (!confirm(`Delete app "${name}"?`)) return;
      const deleteFiles = confirm('Also delete its files on disk (~/deploy-apps/' + name + ')?');
      await api(`/api/apps/${encodeURIComponent(name)}${deleteFiles ? '?deleteFiles=1' : ''}`, { method: 'DELETE' });
    } else {
      await api(`/api/apps/${encodeURIComponent(name)}/${act}`, { method: 'POST', body: '{}' });
    }
  } catch (err) {
    alert(err.message);
  }
});

// new app form
$('#new-app-btn').addEventListener('click', () => $('#new-app-form').classList.toggle('hidden'));
$('#new-app-cancel').addEventListener('click', () => $('#new-app-form').classList.add('hidden'));

$('#app-method').addEventListener('change', (e) => {
  const m = e.target.value;
  $$('.method-field').forEach((f) => f.classList.add('hidden'));
  $$(`.method-${m}`).forEach((f) => f.classList.remove('hidden'));
});

$('#new-app-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const f = form.elements; // form.name / form.method are shadowed by built-ins
  const msg = $('#app-form-msg');
  msg.textContent = 'deploying…';
  const method = f.method.value;
  try {
    let result;
    if (method === 'upload') {
      const fd = new FormData();
      fd.append('name', f.name.value);
      fd.append('command', f.command.value);
      fd.append('cwd', f.cwd.value);
      fd.append('autoStart', f.autoStart.checked ? 'true' : 'false');
      if (f.file.files[0]) fd.append('file', f.file.files[0]);
      result = await api('/api/apps/upload', { method: 'POST', body: fd });
    } else {
      result = await api('/api/apps', {
        method: 'POST',
        body: JSON.stringify({
          name: f.name.value,
          method,
          repoUrl: f.repoUrl.value,
          filename: f.filename.value,
          content: f.content.value,
          command: f.command.value,
          cwd: f.cwd.value,
          autoStart: f.autoStart.checked,
        }),
      });
    }
    msg.textContent = result.deployNote || 'deployed';
    form.reset();
    setTimeout(() => { $('#new-app-form').classList.add('hidden'); msg.textContent = ''; }, 1500);
  } catch (err) {
    msg.textContent = err.message;
  }
});

/* ================= workflows ================= */

function renderWorkflows(list) {
  appState.workflows = list;
  const wrap = $('#wf-list');
  if (!list.length) {
    wrap.innerHTML = '<p class="muted">No workflows saved yet.</p>';
    return;
  }
  wrap.innerHTML = list.map((wf) => `
    <div class="wf-item" data-id="${wf.id}">
      <div class="row spread">
        <strong>${esc(wf.name)}</strong>
        <span>
          <button class="btn small primary" data-act="run" ${wf.running ? 'disabled' : ''}>
            ${wf.running ? 'Running…' : '▶ Run'}
          </button>
          <button class="btn small danger" data-act="delete">Delete</button>
        </span>
      </div>
      <div class="wf-cmd">${esc(wf.command)}</div>
      <div class="row">
        <button class="btn small ghost" data-act="history">History (${wf.history.length})</button>
        ${wf.cwd ? `<span class="muted">cwd: ${esc(wf.cwd)}</span>` : ''}
      </div>
      <div class="wf-history hidden">${renderHistory(wf.history)}</div>
    </div>`).join('');
}

function renderHistory(history) {
  if (!history.length) return '<span class="muted">no runs yet</span>';
  const rows = [...history].reverse().map((h) => `
    <tr>
      <td>${new Date(h.ts).toLocaleString()}</td>
      <td class="${h.exitCode === 0 ? 'exit-ok' : 'exit-bad'}">exit ${h.exitCode === null ? '–' : h.exitCode}</td>
      <td>${(h.durationMs / 1000).toFixed(1)}s</td>
    </tr>`).join('');
  return `<table>${rows}</table>`;
}

$('#wf-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const item = btn.closest('.wf-item');
  const id = item.dataset.id;
  const act = btn.dataset.act;
  if (act === 'history') {
    item.querySelector('.wf-history').classList.toggle('hidden');
    return;
  }
  if (act === 'delete') {
    if (!confirm('Delete this workflow?')) return;
    try { await api(`/api/workflows/${id}`, { method: 'DELETE' }); } catch (err) { alert(err.message); }
    return;
  }
  if (act === 'run') {
    try {
      await api(`/api/workflows/${id}/run`, { method: 'POST', body: '{}' });
      openModal(`Workflow output`, {
        sub: () => socket.emit('workflow:subscribe', id),
        unsub: () => socket.emit('workflow:unsubscribe', id),
      });
      $('#modal-footer').textContent = 'running…';
    } catch (err) {
      alert(err.message);
    }
  }
});

$('#new-wf-btn').addEventListener('click', () => $('#new-wf-form').classList.toggle('hidden'));
$('#new-wf-cancel').addEventListener('click', () => $('#new-wf-form').classList.add('hidden'));

$('#new-wf-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const f = form.elements; // form.name is shadowed by the form's own name property
  const msg = $('#wf-form-msg');
  try {
    await api('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({ name: f.name.value, command: f.command.value, cwd: f.cwd.value }),
    });
    msg.textContent = '';
    form.reset();
    $('#new-wf-form').classList.add('hidden');
  } catch (err) {
    msg.textContent = err.message;
  }
});

/* ================= tunnels ================= */

function renderTunnel(t) {
  appState.tunnel = t;
  const state = $('#tunnel-state');
  state.textContent = t.running ? 'running' : 'not running';
  state.className = `pill ${t.running ? 'running' : 'stopped'}`;
  $('#tunnel-since').textContent = t.running && t.since ? `since ${new Date(t.since).toLocaleTimeString()}` : '';
  $('#tunnel-binary').textContent = t.binaryAvailable
    ? 'found'
    : 'NOT FOUND — run: pkg install cloudflared';
  $('#tunnel-token-state').textContent = t.tokenSaved ? 'token saved ✓ (hidden)' : 'no token saved';
  $('#tunnel-start').disabled = t.running || !t.tokenSaved || !t.binaryAvailable;
  $('#tunnel-stop').disabled = !t.running;
  $('#tunnel-log').textContent = t.recentLog.length ? t.recentLog.join('\n') : '–';
  $('#tunnel-badge').classList.toggle('hidden', !t.running);
}

$('#tunnel-start').addEventListener('click', async () => {
  try { await api('/api/tunnel/start', { method: 'POST', body: '{}' }); }
  catch (err) { $('#tunnel-msg').textContent = err.message; }
});

$('#tunnel-stop').addEventListener('click', async () => {
  try { await api('/api/tunnel/stop', { method: 'POST', body: '{}' }); }
  catch (err) { $('#tunnel-msg').textContent = err.message; }
});

$('#tunnel-token-save').addEventListener('click', async () => {
  const input = $('#tunnel-token-input');
  try {
    await api('/api/tunnel/token', { method: 'POST', body: JSON.stringify({ token: input.value }) });
    input.value = '';
    $('#tunnel-msg').textContent = 'Token saved. It will not be shown again.';
  } catch (err) {
    $('#tunnel-msg').textContent = err.message;
  }
});

/* ================= terminal ================= */

let termApi = null;

function initTerminal() {
  if (termApi || typeof Terminal === 'undefined') return;

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
    theme: {
      background: '#0b0b12',
      foreground: '#e6e6f0',
      cursor: '#7c6af7',
      selectionBackground: '#7c6af755',
    },
    rightClickSelectsWord: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('#terminal-container'));
  fit.fit();

  term.onData((data) => { if (socket) socket.emit('term:input', data); });

  // auto-copy selection (best effort — mobile browsers may block it)
  term.onSelectionChange(() => {
    const sel = term.getSelection();
    if (sel) { navigator.clipboard?.writeText(sel).catch(() => {}); }
  });

  // Ctrl+Shift+V paste
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
      navigator.clipboard?.readText().then((t) => socket.emit('term:input', t)).catch(() => {});
      return false;
    }
    return true;
  });

  const startSession = () => {
    socket.emit('term:start', { cols: term.cols, rows: term.rows });
  };
  startSession();

  const onResize = () => {
    try {
      fit.fit();
      socket.emit('term:resize', { cols: term.cols, rows: term.rows });
    } catch { /* not visible */ }
  };
  window.addEventListener('resize', onResize);

  $('#term-copy').addEventListener('click', async () => {
    const sel = term.getSelection();
    if (sel) { try { await navigator.clipboard.writeText(sel); } catch { /* denied */ } }
  });
  $('#term-paste').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) socket.emit('term:input', text);
    } catch {
      alert('Clipboard read blocked by the browser — use Ctrl+Shift+V or the keyboard paste instead.');
    }
  });
  $('#term-reconnect').addEventListener('click', () => {
    term.reset();
    startSession();
    term.focus();
  });

  socket.on('term:output', (data) => term.write(data));
  socket.on('connect', () => { term.reset(); startSession(); });

  termApi = { term, fit: onResize };
  term.focus();
}

/* ================= settings ================= */

async function loadSettings() {
  try {
    const s = await api('/api/settings');
    $('#env-table').innerHTML = `
      <tr><td class="muted">Shell</td><td><code>${esc(s.shell)}</code></td></tr>
      <tr><td class="muted">$PREFIX</td><td><code>${esc(s.prefix || '–')}</code></td></tr>
      <tr><td class="muted">Data dir</td><td><code>${esc(s.dataDir)}</code></td></tr>
      <tr><td class="muted">State file</td><td><code>${esc(s.stateFile)}</code></td></tr>
      <tr><td class="muted">sshd</td><td>${s.sshd.installed
        ? (s.sshd.running ? '<span class="pill running">running</span>' : '<span class="pill stopped">installed, not running</span>')
        : '<span class="pill stopped">not installed</span>'}</td></tr>`;
  } catch (err) {
    $('#env-table').innerHTML = `<tr><td class="error">${esc(err.message)}</td></tr>`;
  }
}

$('#regen-token-btn').addEventListener('click', async () => {
  if (!confirm('Regenerate the access token? Every other logged-in session will be invalidated.')) return;
  try {
    const res = await api('/api/settings/regenerate-token', { method: 'POST', body: '{}' });
    $('#new-token-val').textContent = res.token;
    $('#new-token-box').classList.remove('hidden');
  } catch (err) {
    alert(err.message);
  }
});

$('#copy-token-btn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#new-token-val').textContent); } catch { /* denied */ }
});

/* ================= socket wiring ================= */

function connectSocket() {
  if (socket) socket.disconnect();
  socket = io();

  socket.on('health:update', renderHealth);

  socket.on('app:status', renderApps);
  socket.on('app:log', ({ name, data, replay }) => {
    if ($('#modal').classList.contains('hidden')) return;
    if ($('#modal-title').textContent !== `Logs — ${name}`) return;
    if (replay) $('#modal-body').textContent = data;
    else modalAppend(data);
  });

  socket.on('workflow:status', renderWorkflows);
  socket.on('workflow:log', (msg) => {
    if ($('#modal').classList.contains('hidden')) return;
    if (msg.data) modalAppend(msg.data);
    if (msg.exit) {
      $('#modal-footer').textContent =
        `exit code ${msg.exitCode === null ? '–' : msg.exitCode} · ${(msg.durationMs / 1000).toFixed(1)}s`;
    }
  });
  socket.on('workflow:history', ({ history }) => {
    $('#modal-footer').textContent = `history: ${history.length} previous run(s)`;
  });

  socket.on('tunnel:status', renderTunnel);

  socket.on('connect_error', (err) => {
    if (String(err.message).includes('unauthorized')) showLogin();
  });
}

/* ================= boot ================= */

async function boot() {
  try {
    await api('/api/me');
  } catch {
    showLogin();
    return;
  }
  showApp();
  connectSocket();
  // one-shot initial loads; live updates arrive over the socket after this
  try {
    renderApps(await api('/api/apps'));
    renderWorkflows(await api('/api/workflows'));
    renderTunnel(await api('/api/tunnel'));
    renderHealth(await api('/api/health'));
  } catch { /* socket will fill in */ }
}

boot();

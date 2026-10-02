// 第 2 层：右侧 AI 对话框。
//
// 流程：输入问题 → 带「工作簿快照」调 chat completion → 模型回 markdown + ```js 代码块
//   → 用户点「运行」（或开自动执行）→ sandbox 里执行 IC.* → 刷新表格。
// 每次改动前存一份 xlsx 快照，可以一键回滚。
//
// 纯浏览器模块；核心逻辑（provider / sandbox / context / markdown）都在别的文件里，
// 可以在 Node 里单测，见 tmp/test_ai.mjs。

import { createProvider, ApiError, normalizeBaseUrl } from './provider.js';
import { runAiCode, IC_WHITELIST, summarizeOps } from './sandbox.js';
import { buildContext, buildMessages } from './context.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { extractCodeBlocks, renderMarkdown } from './markdown.js';

const LS_SETTINGS = 'ironcalc.ai.settings.v1';
const LS_SESSIONS = 'ironcalc.ai.sessions.v1';
const LS_UI = 'ironcalc.ai.ui.v1';
const MAX_SESSIONS = 20;
const MAX_MESSAGES = 80;

const WELCOME = [
  '你好，我是表格助手 👋',
  '',
  '直接用中文说要改什么，比如：',
  '- `把 D2:D4 改成含税价，税率 6%`',
  '- `在 B5 写合计公式，并把表头加粗居中`',
  '- `新建一个「汇总」表，把 Sheet1 的 A1:D5 抄过去`',
  '',
  '点我给的代码块上的「运行」才会真正改表（也可以在下面勾「自动执行」）。',
  '右上角 ⚙ 配置 endpoint / api key / model；本地可以跑 `scripts/mock-api.sh` 起个假服务试。',
].join('\n');

export function initAiPanel(IC) {
  const $ = (id) => document.getElementById(id);
  const panel = $('ai-panel');
  if (!panel) return null;

  // ------------------------------------------------------------ state
  const state = {
    settings: loadJson(LS_SETTINGS, {
      baseUrl: '',
      apiKey: '',
      model: '',
      temperature: '',
      context: true,
      stream: true,
      autoRun: false,
    }),
    sessions: [],
    currentId: null,
    busy: false,
    abort: null,
  };
  const snapshots = new Map();
  let snapSeq = 0;
  let msgSeq = 0;
  let sessSeq = 0;

  const id = (p) => `${p}${Date.now().toString(36)}${(++msgSeq).toString(36)}`;

  // ------------------------------------------------------------ persistence
  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return clone(fallback);
      return { ...clone(fallback), ...JSON.parse(raw) };
    } catch { return clone(fallback); }
  }
  function loadSessions() {
    try {
      const raw = localStorage.getItem(LS_SESSIONS);
      const arr = raw ? JSON.parse(raw) : [];
      if (Array.isArray(arr) && arr.length) {
        for (const s of arr) {
          for (const m of s.messages || []) {
            if (m.runs) for (const r of Object.values(m.runs)) delete r.snapshotId; // 快照不跨刷新
          }
        }
        return arr;
      }
    } catch { /* ignore */ }
    return [];
  }
  function saveSessions() {
    try {
      const data = state.sessions.map((s) => ({
        id: s.id,
        title: s.title,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messages: (s.messages || []).slice(-MAX_MESSAGES).map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          at: m.at,
          runs: m.runs
            ? Object.fromEntries(Object.entries(m.runs).map(([k, v]) => [k, { status: v.status, text: v.text, at: v.at }]))
            : undefined,
          logs: m.logs ? m.logs.slice(0, 5) : undefined,
        })),
      }));
      localStorage.setItem(LS_SESSIONS, JSON.stringify(data));
    } catch (e) { console.warn('[AI] 保存会话失败', e); }
  }
  function saveSettings() {
    try { localStorage.setItem(LS_SETTINGS, JSON.stringify(state.settings)); } catch { /* ignore */ }
  }
  function saveUi() {
    try {
      localStorage.setItem(LS_UI, JSON.stringify({
        currentId: state.currentId,
        open: !panel.classList.contains('collapsed'),
      }));
    } catch { /* ignore */ }
  }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  // ------------------------------------------------------------ sessions
  function currentSession() {
    let s = state.sessions.find((x) => x.id === state.currentId);
    if (!s) { s = createSession(false); }
    return s;
  }
  function createSession(persist = true) {
    const s = {
      id: id('s'),
      title: '新会话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [{ id: id('m'), role: 'assistant', content: WELCOME, at: Date.now() }],
    };
    state.sessions.unshift(s);
    state.currentId = s.id;
    if (state.sessions.length > MAX_SESSIONS) state.sessions.length = MAX_SESSIONS;
    if (persist) { saveSessions(); renderSessionList(); renderMessages(); }
    return s;
  }
  function renderSessionList() {
    const sel = $('ai-session');
    sel.innerHTML = '';
    for (const s of state.sessions) {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.title;
      sel.appendChild(o);
    }
    sel.value = state.currentId;
  }

  // ------------------------------------------------------------ message rendering
  function renderMessages() {
    const box = $('ai-messages');
    const s = currentSession();
    box.innerHTML = '';
    s.messages.forEach((m, i) => box.appendChild(messageEl(m, i)));
    box.scrollTop = box.scrollHeight;
  }

  function messageEl(m, index) {
    const wrap = document.createElement('div');
    wrap.className = 'ai-msg ' + m.role;
    wrap.dataset.msg = String(index);

    const bubble = document.createElement('div');
    bubble.className = 'ai-bubble';

    if (m.role === 'user') {
      bubble.textContent = m.content;
    } else {
      const blocks = extractCodeBlocks(m.content);
      const runs = m.runs || {};
      const blockMeta = blocks.map((b, i) => {
        const run = runs[i];
        return {
          runnable: b.runnable,
          label: run ? (run.status === 'error' ? '重新运行' : '再运行一次') : '运行',
        };
      });
      const md = document.createElement('div');
      md.className = 'ai-md';
      md.innerHTML = renderMarkdown(m.content || '…', { blockMeta });
      bubble.appendChild(md);

      const notes = [];
      for (const [i, r] of Object.entries(runs).sort((a, b) => Number(a[0]) - Number(b[0]))) {
        const prefix = Object.keys(runs).length > 1 ? `第 ${Number(i) + 1} 段：` : '';
        notes.push({ kind: r.status, text: prefix + r.text });
      }
      if (m.logs?.length) notes.push({ kind: 'muted', text: 'console: ' + m.logs.map((l) => l.text).join(' | ') });
      if (notes.length) {
        const box = document.createElement('div');
        box.className = 'ai-notes';
        for (const n of notes) {
          const d = document.createElement('div');
          d.className = 'ai-note ' + (n.kind === 'error' ? 'err' : n.kind === 'muted' ? 'muted' : 'ok');
          d.textContent = n.text;
          box.appendChild(d);
        }
        if (m.snapshotId && snapshots.has(m.snapshotId)) {
          const b = document.createElement('button');
          b.className = 'btn tiny';
          b.dataset.rollback = m.snapshotId;
          b.textContent = '回滚这次改动';
          box.appendChild(b);
        }
        bubble.appendChild(box);
      }
    }

    wrap.appendChild(bubble);
    return wrap;
  }

  function updateStreamingBubble(index) {
    const wrap = $('ai-messages').querySelector(`.ai-msg[data-msg="${index}"]`);
    if (!wrap) return;
    wrap.classList.add('streaming');
    const md = wrap.querySelector('.ai-md');
    const m = currentSession().messages[index];
    const blocks = extractCodeBlocks(m.content);
    md.innerHTML = renderMarkdown(m.content || '…', { blockMeta: blocks.map(() => ({ runnable: false })) });
    const box = $('ai-messages');
    box.scrollTop = box.scrollHeight;
  }

  // ------------------------------------------------------------ running code
  async function runBlock(msgIndex, blockIndex) {
    const s = currentSession();
    const m = s.messages[msgIndex];
    if (!m || m.role !== 'assistant') return;
    const block = extractCodeBlocks(m.content)[blockIndex];
    if (!block) return;

    if (!m.snapshotId) {
      try {
        const sid = id('snap');
        snapshots.set(sid, IC.toXlsx());
        m.snapshotId = sid;
        m.snapshotName = IC.getName();
      } catch (e) { console.warn('[AI] 快照失败', e); }
    }

    m.runs = m.runs || {};
    setStatus('执行中…');
    let res;
    try {
      res = await runAiCode(block.code, IC, { whitelist: IC_WHITELIST });
    } catch (e) {
      res = { ok: false, error: { message: String(e?.message || e) }, ops: [], logs: [], ms: 0 };
    }
    // 纯视觉高亮这次真正动过的区域（失败前已执行的也算），不会修改单元格样式
    try { IC.highlightOps?.(res.ops || []); } catch { /* ignore */ }
    if (res.ok) {
      const what = summarizeOps(res.ops) || '没有调用 IC（纯计算？）';
      let text = `✅ 已执行：${what}（${Math.round(res.ms)}ms）`;
      if (res.result !== undefined && res.result !== null && res.result !== '') {
        text += ` · 返回 ${JSON.stringify(res.result)}`;
      }
      m.runs[blockIndex] = { status: 'ok', text, at: Date.now() };
    } else {
      m.runs[blockIndex] = {
        status: 'error',
        text: `❌ 执行失败${res.failedAt ? `（在 ${res.failedAt}）` : ''}：${res.error.message}`,
        at: Date.now(),
      };
    }
    if (res.logs?.length) m.logs = (m.logs || []).concat(res.logs);
    try { IC.refresh(); } catch { /* ignore */ }
    setStatus('');
    saveSessions();
    renderMessages();
  }

  function rollback(snapshotId) {
    const bytes = snapshots.get(snapshotId);
    if (!bytes) { toastHint('快照已失效（刷新过页面？）'); return; }
    const name = currentSession().messages.find((m) => m.snapshotId === snapshotId)?.snapshotName || IC.getName();
    try {
      IC.fromXlsx(bytes, name);
      snapshots.delete(snapshotId);
      toastHint('已回滚到这次 AI 改动之前');
    } catch (e) {
      toastHint('回滚失败：' + (e?.message || e));
    }
    saveSessions();
    renderMessages();
  }

  // ------------------------------------------------------------ sending
  async function send() {
    if (state.busy) return;
    const input = $('ai-input');
    const text = input.value.trim();
    if (!text) return;
    if (!state.settings.baseUrl || !state.settings.model) {
      openConfig(true);
      setConfigMsg('先填好 Endpoint 和 Model 再发送。', 'err');
      return;
    }

    const s = currentSession();
    s.messages.push({ id: id('m'), role: 'user', content: text, at: Date.now() });
    s.updatedAt = Date.now();
    if (s.title === '新会话') { s.title = text.replace(/\s+/g, ' ').slice(0, 20); renderSessionList(); }
    input.value = '';
    renderMessages();
    saveSessions();

    let context = '';
    if (state.settings.context !== false) {
      try { context = buildContext(IC); } catch (e) { console.warn('[AI] 构造上下文失败', e); }
    }
    const history = s.messages.map((m) => ({ role: m.role, content: m.content }));
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...buildMessages({ history, context })];

    const assistant = { id: id('m'), role: 'assistant', content: '', at: Date.now() };
    s.messages.push(assistant);
    const index = s.messages.length - 1;
    renderMessages();

    state.busy = true;
    state.abort = new AbortController();
    setBusy(true);
    const provider = createProvider(() => state.settings);
    try {
      const useStream = state.settings.stream !== false;
      try {
        await provider.chat(messages, {
          stream: useStream,
          signal: state.abort.signal,
          onDelta: (_d, full) => { assistant.content = full; updateStreamingBubble(index); },
        });
      } catch (e) {
        const authFail = e instanceof ApiError && (e.status === 401 || e.status === 403);
        if (useStream && !authFail && !assistant.content && !state.abort.signal.aborted) {
          // 有些 endpoint 不支持流式，退化成一次性返回再试
          const r = await provider.chat(messages, { stream: false, signal: state.abort.signal });
          assistant.content = r.content;
        } else {
          throw e;
        }
      }
      if (!assistant.content.trim()) assistant.content = '（模型返回了空内容）';
    } catch (e) {
      console.error('[AI] 请求失败', e?.cause ?? e);
      const msg = e instanceof ApiError ? e.message : String(e?.message || e);
      assistant.content = (assistant.content ? assistant.content + '\n\n' : '') + `> ⚠️ 请求失败：${msg}`;
    } finally {
      state.busy = false;
      state.abort = null;
      setBusy(false);
      setStatus('');
      s.updatedAt = Date.now();
      saveSessions();
      renderMessages();
    }

    if (state.settings.autoRun) {
      const blocks = extractCodeBlocks(assistant.content);
      for (let i = 0; i < blocks.length; i++) {
        if (blocks[i].runnable) await runBlock(index, i);
      }
    }
  }

  // ------------------------------------------------------------ config UI
  function openConfig(force) {
    const el = $('ai-config');
    const show = force === true ? true : el.classList.contains('hidden');
    el.classList.toggle('hidden', !show);
    if (show) fillConfig();
  }
  function fillConfig() {
    const c = state.settings;
    $('ai-baseurl').value = c.baseUrl || '';
    $('ai-apikey').value = c.apiKey || '';
    $('ai-model').value = c.model || '';
    $('ai-temp').value = c.temperature ?? '';
    $('ai-context').checked = c.context !== false;
    $('ai-stream').checked = c.stream !== false;
  }
  function readConfigForm() {
    state.settings.baseUrl = $('ai-baseurl').value.trim();
    state.settings.apiKey = $('ai-apikey').value.trim();
    state.settings.model = $('ai-model').value.trim();
    const t = $('ai-temp').value.trim();
    state.settings.temperature = t === '' ? '' : Number(t);
    state.settings.context = $('ai-context').checked;
    state.settings.stream = $('ai-stream').checked;
  }
  function applyConfig(save = true) {
    readConfigForm();
    if (save) saveSettings();
    renderStatus();
  }
  function renderStatus() {
    const c = state.settings;
    let host = c.baseUrl || '(未配置 endpoint)';
    try { host = c.baseUrl ? normalizeBaseUrl(c.baseUrl) : host; } catch { /* keep raw */ }
    $('ai-status').textContent = c.model ? `${c.model} @ ${host}` : host;
  }
  function setConfigMsg(text, kind) {
    const el = $('ai-config-msg');
    el.textContent = text;
    el.className = 'ai-hint' + (kind ? ' ' + kind : '');
  }
  async function testConfig() {
    applyConfig(false);
    setConfigMsg('测试中…');
    try {
      const provider = createProvider(() => state.settings);
      const models = await provider.listModels();
      setConfigMsg(models.length
        ? `连接成功，看到 ${models.length} 个模型：${models.slice(0, 5).join(', ')}${models.length > 5 ? ' …' : ''}`
        : '连接成功，但 /models 返回为空（也可能 endpoint 不实现 /models）。直接发消息试试。', 'ok');
    } catch (e) {
      console.error('[AI] 连接测试失败', e?.cause ?? e);
      setConfigMsg('连接失败：' + (e?.message || e), 'err');
    }
  }
  function setBusy(busy) {
    $('ai-send').disabled = busy;
    $('ai-input').disabled = busy;
    $('ai-stop').classList.toggle('hidden', !busy);
  }
  function setStatus(text) {
    if (text) $('ai-status').textContent = text;
    else renderStatus();
  }
  function toastHint(text) {
    try { IC.toast(text); } catch { /* ignore */ }
  }

  // ------------------------------------------------------------ wire up
  state.sessions = loadSessions();
  const ui = loadJson(LS_UI, { currentId: null, open: false });
  state.currentId = ui.currentId && state.sessions.some((s) => s.id === ui.currentId) ? ui.currentId : null;
  if (!state.sessions.length) createSession(false);
  if (!state.currentId) state.currentId = state.sessions[0].id;
  panel.classList.toggle('collapsed', !ui.open);
  syncToggle();
  renderSessionList();
  renderMessages();
  fillConfig();
  renderStatus();

  function syncToggle() {
    $('btn-ai').classList.toggle('on', !panel.classList.contains('collapsed'));
  }

  $('btn-ai').onclick = () => {
    panel.classList.toggle('collapsed');
    if (!panel.classList.contains('collapsed')) { $('ai-input').focus(); renderMessages(); }
    syncToggle();
    saveUi();
  };
  $('ai-close').onclick = () => { panel.classList.add('collapsed'); syncToggle(); saveUi(); };
  $('ai-new-session').onclick = () => createSession(true);
  $('ai-settings-btn').onclick = () => openConfig();
  $('ai-save-cfg').onclick = () => { applyConfig(true); setConfigMsg('已保存。', 'ok'); };
  $('ai-test-cfg').onclick = () => testConfig();
  $('ai-session').onchange = (ev) => {
    state.currentId = ev.target.value;
    renderMessages();
    saveUi();
  };
  $('ai-del-session').onclick = () => {
    state.sessions = state.sessions.filter((x) => x.id !== state.currentId);
    state.currentId = null;
    if (!state.sessions.length) createSession(false);
    else { state.currentId = state.sessions[0].id; }
    saveSessions();
    renderSessionList();
    renderMessages();
  };
  $('ai-autorun').checked = !!state.settings.autoRun;
  $('ai-autorun').onchange = (ev) => { state.settings.autoRun = ev.target.checked; saveSettings(); };
  $('ai-send').onclick = () => send();
  $('ai-stop').onclick = () => { state.abort?.abort(); setStatus('已请求停止…'); };
  $('ai-input').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      send();
    }
  });
  $('ai-messages').addEventListener('click', (ev) => {
    const runBtn = ev.target.closest('.ai-run');
    if (runBtn) {
      const wrap = runBtn.closest('.ai-msg');
      runBlock(Number(wrap.dataset.msg), Number(runBtn.dataset.block));
      return;
    }
    const rb = ev.target.closest('[data-rollback]');
    if (rb) rollback(rb.dataset.rollback);
  });

  const api = {
    state,
    send,
    runBlock,
    rollback,
    newSession: () => createSession(true),
    open: () => { panel.classList.remove('collapsed'); syncToggle(); saveUi(); },
  };
  window.AI = api;
  return api;
}

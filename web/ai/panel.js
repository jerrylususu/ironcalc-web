// 第 2 层：右侧 AI 对话框。
//
// 流程：输入问题 → 带「工作簿快照」调 chat completion → 模型回 markdown + ```js 代码块
//   → 用户点「运行」（或开自动执行）→ sandbox 里执行 IC.* → 刷新表格。
// 每次改动前存一份 xlsx 快照，可以一键回滚。
//
// 纯浏览器模块；核心逻辑（provider / sandbox / context / markdown）都在别的文件里，
// 可以在 Node 里单测，见 tmp/test_ai.mjs。

import { createProvider, ApiError, normalizeBaseUrl } from './provider.js';
import { runAiCode, IC_WHITELIST, IC_WRITE_METHODS, summarizeOps, isReadOnlyCode, scanCode } from './sandbox.js';
import { buildContext, buildMessages, composeUserContent, messagesToApi } from './context.js';
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
    // 每次撤销/重做/回滚 +1；执行记录里存的 seq 与之不等时，"运行"按钮重新可点
    undoSeq: 0,
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
          reasoning: m.reasoning ? String(m.reasoning).slice(0, 8000) : undefined,
          usage: m.usage || undefined,
          ttftMs: m.ttftMs,
          at: m.at,
          runs: m.runs
            ? Object.fromEntries(Object.entries(m.runs).map(([k, v]) => [k, { status: v.status, text: v.text, at: v.at, wrote: v.wrote, seq: v.seq }]))
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

  /** 执行成功且是写操作的代码块：跑过就把「运行」禁掉，撤销/重做/回滚后可重跑。 */
  function runDisabled(run) {
    if (!run || run.status !== 'ok' || !run.wrote) return false;
    return run.seq === undefined ? true : run.seq === state.undoSeq;
  }

  function shortNum(n) {
    if (n === null || n === undefined) return '?';
    return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  }

  /** 一条消息底部的「首字延迟 · token」元信息。 */
  function usageText(m) {
    const parts = [];
    if (typeof m.ttftMs === 'number') parts.push(`首字 ${(m.ttftMs / 1000).toFixed(1)}s`);
    const u = m.usage;
    if (u && (u.total_tokens || u.prompt_tokens || u.completion_tokens)) {
      parts.push(`↑${shortNum(u.prompt_tokens)} ↓${shortNum(u.completion_tokens)}`);
      const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens;
      if (cached) parts.push(`缓存 ${shortNum(cached)}`);
      if (u.completion_tokens_details?.reasoning_tokens) {
        parts.push(`思考 ${shortNum(u.completion_tokens_details.reasoning_tokens)}`);
      }
    }
    return parts.join(' · ');
  }

  /** 把一条消息渲染成气泡 DOM（普通渲染和流式刷新共用）。 */
  function buildBubble(m, { streaming = false } = {}) {
    const bubble = document.createElement('div');
    bubble.className = 'ai-bubble';
    if (m.role === 'user') { bubble.textContent = m.content; return bubble; }

    if (m.reasoning) {
      const d = document.createElement('details');
      d.className = 'ai-think';
      if (streaming || !m.reasoningDone) d.open = true;
      const sum = document.createElement('summary');
      sum.textContent = m.reasoningDone ? '思考过程' : '思考中…';
      const body = document.createElement('div');
      body.className = 'ai-think-body';
      body.textContent = m.reasoning;
      d.append(sum, body);
      bubble.appendChild(d);
    }

    const blocks = extractCodeBlocks(m.content);
    const runs = m.runs || {};
    const blockMeta = blocks.map((b, i) => {
      const run = runs[i];
      const disabled = runDisabled(run);
      let label = '运行';
      if (disabled) label = '已执行';
      else if (run?.status === 'error') label = '重新运行';
      else if (run) label = '再运行一次';
      else if (b.runnable && isReadOnlyCode(b.code)) label = '只读 · 自动运行';
      return { runnable: b.runnable, label, disabled };
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

    const meta = usageText(m);
    if (meta) {
      const d = document.createElement('div');
      d.className = 'ai-meta';
      d.textContent = meta;
      bubble.appendChild(d);
    }
    return bubble;
  }

  function messageEl(m, index) {
    const wrap = document.createElement('div');
    wrap.className = 'ai-msg ' + m.role;
    wrap.dataset.msg = String(index);
    wrap.appendChild(buildBubble(m));
    return wrap;
  }

  function updateStreamingBubble(index) {
    const wrap = $('ai-messages').querySelector(`.ai-msg[data-msg="${index}"]`);
    if (!wrap) return;
    wrap.classList.add('streaming');
    const m = currentSession().messages[index];
    const old = wrap.querySelector('.ai-bubble');
    const next = buildBubble(m, { streaming: true });
    if (old) wrap.replaceChild(next, old);
    else wrap.appendChild(next);
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
      const wrote = (res.ops || []).some((op) => IC_WRITE_METHODS.includes(op.name));
      m.runs[blockIndex] = { status: 'ok', text, at: Date.now(), wrote, seq: state.undoSeq };
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
    // 回滚后允许重跑（run.seq 与 undoSeq 不再相等）
    state.undoSeq += 1;
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
    let context = '';
    if (state.settings.context !== false) {
      try { context = buildContext(IC); } catch (e) { console.warn('[AI] 构造上下文失败', e); }
    }
    // 快照在发消息当刻就拼进 apiContent 存下来：历史消息内容此后不再变，prefix cache 才保得住
    s.messages.push({
      id: id('m'),
      role: 'user',
      content: text,
      apiContent: composeUserContent(text, context),
      at: Date.now(),
    });
    s.updatedAt = Date.now();
    if (s.title === '新会话') { s.title = text.replace(/\s+/g, ' ').slice(0, 20); renderSessionList(); }
    input.value = '';
    renderMessages();
    saveSessions();

    const history = messagesToApi(s.messages);
    const messages = buildMessages({ history, system: SYSTEM_PROMPT });

    const assistant = { id: id('m'), role: 'assistant', content: '', reasoning: '', at: Date.now() };
    s.messages.push(assistant);
    const index = s.messages.length - 1;
    renderMessages();

    state.busy = true;
    state.abort = new AbortController();
    setBusy(true);
    const provider = createProvider(() => state.settings);
    const absorb = (r) => {
      if (!r) return;
      if (r.content) assistant.content = r.content;
      if (r.reasoning) assistant.reasoning = r.reasoning;
      if (r.usage) assistant.usage = r.usage;
      if (typeof r.ttftMs === 'number') assistant.ttftMs = r.ttftMs;
    };
    try {
      const useStream = state.settings.stream !== false;
      try {
        absorb(await provider.chat(messages, {
          stream: useStream,
          signal: state.abort.signal,
          onDelta: (_d, full) => { assistant.content = full; updateStreamingBubble(index); },
          onReasoning: (_d, full) => { assistant.reasoning = full; updateStreamingBubble(index); },
        }));
      } catch (e) {
        const authFail = e instanceof ApiError && (e.status === 401 || e.status === 403);
        if (useStream && !authFail && !assistant.content && !state.abort.signal.aborted) {
          // 有些 endpoint 不支持流式，退化成一次性返回再试
          absorb(await provider.chat(messages, { stream: false, signal: state.abort.signal }));
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
      assistant.reasoningDone = true;
      state.busy = false;
      state.abort = null;
      setBusy(false);
      setStatus('');
      s.updatedAt = Date.now();
      saveSessions();
      renderMessages();
    }

    // 只读代码块无需确认（不受「自动执行」开关影响）；写代码块只有开了自动执行才自动跑。
    // 被静态扫描拦下的代码不自动跑，留给用户自己点。
    const blocks = extractCodeBlocks(assistant.content);
    for (let i = 0; i < blocks.length; i++) {
      if (!blocks[i].runnable) continue;
      const readOnly = isReadOnlyCode(blocks[i].code) && !scanCode(blocks[i].code).blocked;
      if (readOnly || state.settings.autoRun) await runBlock(index, i);
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

  // 网格里撤销/重做后，重新启用已执行过的「运行」按钮
  document.addEventListener('ic:history', () => {
    state.undoSeq += 1;
    renderMessages();
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

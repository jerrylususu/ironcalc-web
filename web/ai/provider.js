// OpenAI 兼容的 chat completion 客户端。
// 只用 fetch，不依赖 DOM —— 浏览器里由 panel.js 用，Node 里由 tmp/test_ai.mjs 用。
//
// 支持：非流式 / 流式(SSE) / 超时 / 外部 AbortSignal / 错误体解析。

export class ApiError extends Error {
  constructor(message, { status = 0, body = '', url = '', cause } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.url = url;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * 把 fetch 包成「裸调用」。
 *
 * 浏览器里 window.fetch 有 brand check：一旦把它存进普通对象再 obj.fetch(...) 调用，
 * this 就变成了那个对象，于是同步抛 "Illegal invocation"。此时请求根本没发出去，
 * Network 面板里一条记录都没有，而且异常被上层 catch 掉，console 也不会报错。
 * 包一层箭头函数后，内层始终是裸调用（this === undefined），原生 fetch 与自定义
 * 实现（undici / node-fetch / 测试里的 mock）都能正常工作。
 */
function wrapFetch(fn) {
  if (typeof fn !== 'function') return undefined;
  return (url, init) => fn(url, init);
}

/** 网络层异常 → 一句带方向的提示，而不是一律甩锅给 CORS。 */
function networkErrorMessage(e) {
  const raw = e?.message || String(e);
  if (/Illegal invocation/i.test(raw)) {
    return `网络错误：${raw}（fetch 的调用方式有问题：window.fetch 不能挂到对象上再 obj.fetch(...)）`;
  }
  return `网络错误：${raw}（endpoint 是否允许跨域 CORS？）`;
}

export const DEFAULT_TIMEOUT_MS = 120000;

/** 'http://x:8766' → 'http://x:8766/v1'；已带 /v1 或完整 .../chat/completions 则归一化。 */
export function normalizeBaseUrl(baseUrl) {
  let u = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!u) throw new ApiError('未配置 endpoint（base_url）');
  if (/\/chat\/completions$/.test(u)) u = u.replace(/\/chat\/completions$/, '');
  if (/\/v\d+$/.test(u)) return u;
  return u + '/v1';
}

export function chatCompletionsUrl(baseUrl) {
  return normalizeBaseUrl(baseUrl) + '/chat/completions';
}

export function modelsUrl(baseUrl) {
  return normalizeBaseUrl(baseUrl) + '/models';
}

/** 把 OpenAI 风格的错误体变成一句人话。 */
export function describeErrorBody(status, text) {
  const raw = String(text || '').trim();
  let msg = raw.slice(0, 400);
  try {
    const j = JSON.parse(raw);
    const m = j?.error?.message || j?.message || j?.error;
    if (typeof m === 'string' && m) msg = m;
  } catch { /* 不是 JSON 就用原文 */ }
  const prefix = status ? `HTTP ${status}` : '请求失败';
  return msg ? `${prefix}: ${msg}` : prefix;
}

function briefBody(text) {
  const s = String(text || '');
  return s.length > 2000 ? s.slice(0, 2000) + '…' : s;
}

function nowMs() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

/**
 * 各家推理内容字段不统一，这里都认：DeepSeek 用 delta.reasoning_content，
 * 有些 OpenAI 兼容服务用 delta.reasoning，非流式则是 message.reasoning_content。
 */
function reasoningOf(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const v = obj.reasoning_content ?? obj.reasoning;
  return typeof v === 'string' ? v : '';
}

async function readSse(res, opts, signal) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    throw new ApiError('该 endpoint 的流式响应无法读取（没有 response body）', { status: res.status });
  }
  const { onDelta, onReasoning, startedAt } = opts || {};
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let reasoning = '';
  let usage = null;
  let ttftMs = null;
  let finished = false;

  const markFirst = () => {
    if (ttftMs === null && typeof startedAt === 'number') {
      ttftMs = Math.max(0, nowMs() - startedAt);
    }
  };

  const handleLine = (line) => {
    const trimmed = line.replace(/\r$/, '');
    if (!trimmed.startsWith('data:')) return false;
    const data = trimmed.slice(5).trim();
    if (!data) return false;
    if (data === '[DONE]') return true;
    let json;
    try { json = JSON.parse(data); } catch { return false; }
    if (json?.error) throw new ApiError(describeErrorBody(0, JSON.stringify(json)), { body: JSON.stringify(json) });
    // DeepSeek 把 usage 放在最后一个 chunk 的顶层（需请求里带 stream_options.include_usage）
    if (json?.usage) usage = json.usage;
    const choice = json?.choices?.[0];
    const rdelta = reasoningOf(choice?.delta) || reasoningOf(choice?.message);
    const delta = choice?.delta?.content ?? choice?.message?.content;
    if (rdelta) {
      reasoning += rdelta;
      markFirst();
      onReasoning?.(rdelta, reasoning);
    }
    if (delta) {
      content += delta;
      markFirst();
      onDelta?.(delta, content);
    }
    return false;
  };

  while (!finished) {
    const { value, done } = await reader.read();
    if (done) break;
    if (signal?.aborted) { try { await reader.cancel(); } catch { /* ignore */ } break; }
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (handleLine(line)) { finished = true; break; }
    }
  }
  return { content, reasoning, usage, ttftMs };
}

/** 把外部 signal 与超时合成一个 signal，返回 { signal, timedOut, cleanup }。 */
function linkAbort(signal, timeoutMs) {
  const ac = new AbortController();
  let timedOut = false;
  const onAbort = () => ac.abort(signal?.reason ?? new Error('已取消'));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = timeoutMs > 0
    ? setTimeout(() => { timedOut = true; ac.abort(new Error('请求超时')); }, timeoutMs)
    : null;
  return {
    signal: ac.signal,
    isTimeout: () => timedOut,
    cleanup() {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * 创建 provider。config 可以是对象，也可以是返回配置的函数（UI 里配置随时可改）。
 * 配置项：{ baseUrl, apiKey, model, timeoutMs, temperature, headers, fetch }
 */
export function createProvider(config = {}) {
  const readConfig = () => {
    const c = typeof config === 'function' ? config() : config;
    return {
      baseUrl: c?.baseUrl ?? '',
      apiKey: c?.apiKey ?? '',
      model: c?.model ?? '',
      timeoutMs: c?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      temperature: c?.temperature,
      headers: c?.headers ?? {},
      fetch: wrapFetch(c?.fetch ?? globalThis.fetch),
    };
  };

  function authHeaders(c) {
    const h = { 'Content-Type': 'application/json', ...c.headers };
    if (c.apiKey) h.Authorization = `Bearer ${c.apiKey}`;
    return h;
  }

  /**
   * 发一句话，拿回复。
   * opts: { stream, onDelta, onReasoning, signal, model, temperature, messages }
   * 返回 { content, reasoning, usage, ttftMs, raw, streamed }
   *   - reasoning: 推理内容（DeepSeek reasoning_content / 部分兼容实现的 reasoning），没有则 null
   *   - usage: 服务端 token 统计，没有则 null
   *   - ttftMs: 从发请求到第一个 delta 的毫秒数（非流式则为整个响应耗时）
   */
  async function chat(messages, opts = {}) {
    const c = readConfig();
    if (!c.fetch) throw new ApiError('当前环境没有 fetch');
    const model = opts.model || c.model;
    if (!model) throw new ApiError('未配置模型名（model）');

    const url = chatCompletionsUrl(c.baseUrl);
    const body = {
      model,
      messages,
      stream: !!opts.stream,
    };
    // 让服务端在流式响应的最后一个 chunk 里带 usage（OpenAI / DeepSeek 都支持）。
    // 不支持的端点会忽略未知字段；也可用 opts.streamOptions 关掉。
    if (body.stream && opts.streamOptions !== false && c.streamOptions !== false) {
      body.stream_options = { include_usage: true };
    }
    const temperature = opts.temperature ?? c.temperature;
    if (temperature !== undefined && temperature !== null && temperature !== '') {
      body.temperature = Number(temperature);
    }

    const link = linkAbort(opts.signal, opts.timeoutMs ?? c.timeoutMs);
    const startedAt = nowMs();
    try {
      let res;
      try {
        res = await c.fetch(url, {
          method: 'POST',
          headers: authHeaders(c),
          body: JSON.stringify(body),
          signal: link.signal,
        });
      } catch (e) {
        if (link.isTimeout()) throw new ApiError('请求超时（可以调大超时或换 endpoint）', { url });
        if (e?.name === 'AbortError' || opts.signal?.aborted) throw new ApiError('请求已取消', { url });
        throw new ApiError(networkErrorMessage(e), { url, cause: e });
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ApiError(describeErrorBody(res.status, text), {
          status: res.status,
          body: briefBody(text),
          url,
        });
      }

      const isStream = body.stream && res.body;
      if (isStream) {
        // 流式读取时的超时/取消也要归一成 ApiError
        let out;
        try {
          out = await readSse(res, { onDelta: opts.onDelta, onReasoning: opts.onReasoning, startedAt }, link.signal);
        } catch (e) {
          if (e instanceof ApiError) throw e;
          if (link.isTimeout()) throw new ApiError('请求超时（流式响应中途断了）', { url });
          if (e?.name === 'AbortError' || opts.signal?.aborted) throw new ApiError('请求已取消', { url });
          throw new ApiError(`流式读取失败：${e?.message || e}`, { url });
        }
        return {
          content: out.content,
          reasoning: out.reasoning || null,
          usage: out.usage,
          ttftMs: out.ttftMs,
          raw: null,
          streamed: true,
        };
      }

      const json = await res.json();
      const message = json?.choices?.[0]?.message ?? {};
      const content = message.content ?? '';
      return {
        content: typeof content === 'string' ? content : String(content ?? ''),
        reasoning: reasoningOf(message) || null,
        usage: json?.usage ?? null,
        ttftMs: nowMs() - startedAt,
        raw: json,
        streamed: false,
      };
    } finally {
      link.cleanup();
    }
  }

  /** GET /models，用于「测试连接」。返回模型名数组。 */
  async function listModels(opts = {}) {
    const c = readConfig();
    if (!c.fetch) throw new ApiError('当前环境没有 fetch');
    const url = modelsUrl(c.baseUrl);
    const link = linkAbort(opts.signal, opts.timeoutMs ?? Math.min(c.timeoutMs, 20000));
    try {
      const res = await c.fetch(url, { headers: authHeaders(c), signal: link.signal });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ApiError(describeErrorBody(res.status, text), { status: res.status, body: briefBody(text), url });
      }
      const json = await res.json();
      const list = Array.isArray(json?.data) ? json.data : [];
      return list.map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (link.isTimeout()) throw new ApiError('请求超时', { url });
      if (e?.name === 'AbortError') throw new ApiError('请求已取消', { url });
      throw new ApiError(networkErrorMessage(e), { url, cause: e });
    } finally {
      link.cleanup();
    }
  }

  return {
    chat,
    listModels,
    get config() { return readConfig(); },
    url: () => chatCompletionsUrl(readConfig().baseUrl),
  };
}

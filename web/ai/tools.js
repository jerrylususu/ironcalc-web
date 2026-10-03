// 原生 tool / function calling 的工具定义。
//
// 以前的流程是「模型在正文里写一个 ```js 代码块 → 用户点运行」，代码块是自然语言的一部分，
// 需要正则去抽、容易抽错，模型也没法可靠地拿到执行结果。现在改成正规的 tool call：
// 模型调用 `run_script({ code })`，我们把结果作为 role:'tool' 消息回传，形成 agent 循环。
//
// 只暴露一个 `run_script` 工具（而不是 setCell/setRange 一大堆细粒度工具）：
// 沙箱本来就是执行 JS 的，一个工具能覆盖所有 IC.* API，且和旧的代码块模式共用同一套执行路径。

export const RUN_SCRIPT_TOOL = {
  type: 'function',
  function: {
    name: 'run_script',
    description:
      '在工作簿上执行一段 JavaScript（async 环境，可用 await）。代码里可以调用 IC.* API ' +
      '读写单元格、设置样式、操作工作表。返回值、console 输出和报错会作为工具结果返回给你。',
    parameters: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          description: '一句话中文说明这段代码要做什么（会显示给用户，方便确认）',
        },
        code: {
          type: 'string',
          description: '要执行的 JS 代码。只能用 IC.* API；不要写死循环、不要访问网络或 window/document。',
        },
      },
      required: ['code'],
    },
  },
};

export const TOOL_NAME = RUN_SCRIPT_TOOL.function.name;
export const TOOLS = [RUN_SCRIPT_TOOL];

/**
 * 安全解析工具参数。arguments 是模型给的 JSON 字符串，可能残缺/非法。
 * 返回 { ok, value, error }，不抛异常。
 */
export function parseToolArguments(raw) {
  if (raw && typeof raw === 'object') return { ok: true, value: raw };
  const s = String(raw ?? '').trim();
  if (!s) return { ok: true, value: {} };
  try {
    const v = JSON.parse(s);
    if (v && typeof v === 'object' && !Array.isArray(v)) return { ok: true, value: v };
    return { ok: false, value: {}, error: '参数不是 JSON 对象' };
  } catch (e) {
    return { ok: false, value: {}, error: String(e?.message || e) };
  }
}

/** provider 返回的 { id, name, arguments } → 会话里存的 { id, name, raw, args, parseError? }。 */
export function toStoredToolCall(tc) {
  const parsed = parseToolArguments(tc?.arguments);
  return {
    id: tc?.id || '',
    name: tc?.name || '',
    raw: typeof tc?.arguments === 'string' ? tc.arguments : JSON.stringify(tc?.arguments ?? {}),
    args: parsed.value,
    ...(parsed.ok ? {} : { parseError: parsed.error }),
  };
}

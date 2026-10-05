/**
 * Agent tracker: turns one relayed request and its answer into readable steps
 * (the new prompt or tool results the agent sent, then the model's thinking,
 * tool calls, shell commands, MCP calls and answer).
 *
 * Understands Anthropic Messages (Claude Code), OpenAI Responses (Codex), OpenAI
 * Chat Completions (Kimi, Grok and others) and Gemini, as JSON and as SSE
 * streams. Each request carries the whole conversation, so only the part after
 * the model's last turn is taken from it: the earlier part was saved before.
 */
import { TRACE_LIMITS, type TraceStep, type TraceTool } from '@agentbox/shared';

type Json = Record<string, unknown>;

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const obj = (v: unknown): Json | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function clip(text: string): string {
  return text.length > TRACE_LIMITS.stepTextMax
    ? `${text.slice(0, TRACE_LIMITS.stepTextMax)}… [cut, ${String(text.length)} characters in all]`
    : text;
}

function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return '';
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return '[could not be read]';
  }
}

/** Shell tools of the CLIs agentbox wires up. */
const SHELL_TOOLS = new Set([
  'bash',
  'shell',
  'local_shell',
  'exec_command',
  'run_shell_command',
  'run_terminal_cmd',
  'execute_command',
  'terminal',
]);

/** The command line a shell tool was asked to run, when it is in a shape we know. */
function commandOf(input: unknown): string | null {
  const parsed = typeof input === 'string' ? safeJson(input) : input;
  const o = obj(parsed);
  if (!o) return typeof input === 'string' && input.trim() ? input : null;
  const cmd = o['command'] ?? o['cmd'];
  if (typeof cmd === 'string') return cmd;
  if (Array.isArray(cmd)) {
    const parts = cmd.filter((c): c is string => typeof c === 'string');
    // ["bash", "-lc", "ls -la"] reads best as just the script.
    if (parts.length === 3 && /(^|\/)(ba|z)?sh$/.test(parts[0] ?? '') && parts[1]?.endsWith('c')) {
      return parts[2] ?? '';
    }
    return parts.join(' ');
  }
  return null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** A tool call, sorted into an MCP call, a shell command or another tool. */
export function toolStep(name: string, input: unknown): TraceStep {
  if (name.startsWith('mcp__')) {
    const [, server = '', ...tool] = name.split('__');
    return { type: 'mcp', name: `${server} · ${tool.join('__')}`, text: clip(asText(input)) };
  }
  if (SHELL_TOOLS.has(name.toLowerCase())) {
    const command = commandOf(input);
    if (command !== null) return { type: 'command', name, text: clip(command) };
  }
  return {
    type: 'tool_call',
    name,
    text: clip(asText(typeof input === 'string' ? (safeJson(input) ?? input) : input)),
  };
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  return arr(content)
    .map((b) => {
      const o = obj(b);
      if (!o) return '';
      return str(o['text']) || str(o['content']);
    })
    .filter(Boolean)
    .join('\n');
}

// ── What the agent sent ────────────────────────────────────────────────────

/** Anthropic Messages: the user turn after the last assistant turn. */
function anthropicRequest(messages: unknown[]): TraceStep[] {
  const names = new Map<string, string>();
  let lastAssistant = -1;
  messages.forEach((m, i) => {
    const o = obj(m);
    if (o?.['role'] !== 'assistant') return;
    lastAssistant = i;
    for (const b of arr(o['content'])) {
      const blk = obj(b);
      if (blk?.['type'] === 'tool_use') names.set(str(blk['id']), str(blk['name']));
    }
  });
  const steps: TraceStep[] = [];
  for (const m of messages.slice(lastAssistant + 1)) {
    const o = obj(m);
    if (o?.['role'] !== 'user') continue;
    const content = o['content'];
    if (typeof content === 'string') {
      steps.push({ type: 'prompt', text: clip(content) });
      continue;
    }
    for (const b of arr(content)) {
      const blk = obj(b);
      if (!blk) continue;
      if (blk['type'] === 'text') steps.push({ type: 'prompt', text: clip(str(blk['text'])) });
      else if (blk['type'] === 'tool_result') {
        const name = names.get(str(blk['tool_use_id']));
        steps.push({
          type: 'tool_result',
          ...(name ? { name } : {}),
          text: clip(textOfContent(blk['content'])),
        });
      }
    }
  }
  return steps;
}

/** OpenAI Responses: the items after the model's last output. */
function responsesRequest(input: unknown): TraceStep[] {
  if (typeof input === 'string') return [{ type: 'prompt', text: clip(input) }];
  const items = arr(input);
  const names = new Map<string, string>();
  let last = -1;
  items.forEach((it, i) => {
    const o = obj(it);
    if (!o) return;
    const t = str(o['type']);
    if (o['role'] === 'assistant' || t === 'reasoning' || t.endsWith('_call')) last = i;
    if (t.endsWith('_call'))
      names.set(str(o['call_id']), str(o['name']) || t.replace(/_call$/, ''));
  });
  const steps: TraceStep[] = [];
  for (const it of items.slice(last + 1)) {
    const o = obj(it);
    if (!o) continue;
    const t = str(o['type']);
    if (o['role'] === 'user' || (t === 'message' && o['role'] === 'user')) {
      const text = textOfContent(o['content']);
      if (text) steps.push({ type: 'prompt', text: clip(text) });
    } else if (t.endsWith('_call_output')) {
      const name = names.get(str(o['call_id']));
      steps.push({
        type: 'tool_result',
        ...(name ? { name } : {}),
        text: clip(asText(o['output'])),
      });
    }
  }
  return steps;
}

/** OpenAI Chat Completions: the user and tool messages after the last assistant message. */
function chatRequest(messages: unknown[]): TraceStep[] {
  const names = new Map<string, string>();
  let last = -1;
  messages.forEach((m, i) => {
    const o = obj(m);
    if (o?.['role'] !== 'assistant') return;
    last = i;
    for (const c of arr(o['tool_calls'])) {
      const call = obj(c);
      names.set(str(call?.['id']), str(obj(call?.['function'])?.['name']));
    }
  });
  const steps: TraceStep[] = [];
  for (const m of messages.slice(last + 1)) {
    const o = obj(m);
    if (!o) continue;
    if (o['role'] === 'user') {
      const text = textOfContent(o['content']);
      if (text) steps.push({ type: 'prompt', text: clip(text) });
    } else if (o['role'] === 'tool') {
      const name = names.get(str(o['tool_call_id']));
      steps.push({
        type: 'tool_result',
        ...(name ? { name } : {}),
        text: clip(textOfContent(o['content'])),
      });
    }
  }
  return steps;
}

/** Gemini: the user parts after the model's last turn. */
function geminiRequest(contents: unknown[]): TraceStep[] {
  let last = -1;
  contents.forEach((c, i) => {
    if (obj(c)?.['role'] === 'model') last = i;
  });
  const steps: TraceStep[] = [];
  for (const c of contents.slice(last + 1)) {
    for (const p of arr(obj(c)?.['parts'])) {
      const part = obj(p);
      if (!part) continue;
      if (typeof part['text'] === 'string')
        steps.push({ type: 'prompt', text: clip(part['text']) });
      const fr = obj(part['functionResponse']);
      if (fr) {
        steps.push({
          type: 'tool_result',
          name: str(fr['name']),
          text: clip(asText(fr['response'])),
        });
      }
    }
  }
  return steps;
}

/** The new part of what the agent sent: its prompt, or the results of the tools it ran. */
export function requestSteps(body: Buffer | undefined): TraceStep[] {
  if (!body || body.length === 0 || body[0] !== 0x7b) return [];
  const v = obj(safeJson(body.toString('utf8')));
  if (!v) return [];
  if (Array.isArray(v['contents'])) return geminiRequest(v['contents']);
  if ('input' in v) return responsesRequest(v['input']);
  if (Array.isArray(v['messages'])) {
    // Anthropic sends the system prompt apart; Chat Completions has "system" messages.
    const chat = v['messages'].some((m) => {
      const r = obj(m)?.['role'];
      return r === 'system' || r === 'tool';
    });
    const toolBlocks = v['messages'].some((m) =>
      arr(obj(m)?.['content']).some((b) => {
        const t = obj(b)?.['type'];
        return t === 'tool_use' || t === 'tool_result';
      }),
    );
    if (!chat && (toolBlocks || 'system' in v || 'max_tokens' in v))
      return anthropicRequest(v['messages']);
    return chatRequest(v['messages']);
  }
  return [];
}

// ── What the model answered ───────────────────────────────────────────────

/** Collects the answer as it streams past, then reads the steps from it. */
export class TraceCollector {
  readonly #chunks: Buffer[] = [];
  #bytes = 0;
  #overflow = false;

  push(chunk: Buffer): void {
    if (this.#overflow) return;
    this.#bytes += chunk.length;
    if (this.#bytes > MAX_RESPONSE_BYTES) {
      this.#overflow = true;
      this.#chunks.length = 0;
      return;
    }
    this.#chunks.push(chunk);
  }

  finish(contentType: string | undefined): TraceStep[] {
    if (this.#overflow) return [{ type: 'answer', text: '[the answer was too long to save]' }];
    const text = Buffer.concat(this.#chunks).toString('utf8');
    if ((contentType ?? '').includes('text/event-stream')) return responseFromStream(text);
    const v = safeJson(text);
    return v === null ? [] : responseFromJson(v);
  }

  /** Input tokens served from (read) and written to the provider's prompt cache. */
  cache(): { read: number | null; write: number | null } {
    const out: { read: number | null; write: number | null } = { read: null, write: null };
    if (this.#overflow) return out;
    const text = Buffer.concat(this.#chunks).toString('utf8');
    const objects =
      text.trimStart().startsWith('{') && safeJson(text) !== null
        ? [safeJson(text)]
        : text
            .split('\n')
            .map((l) => l.replace(/\r$/, ''))
            .filter((l) => l.startsWith('data:'))
            .map((l) => safeJson(l.slice(5).trim()));
    for (const o of objects) {
      const e = obj(o);
      if (!e) continue;
      const u =
        obj(e['usage']) ??
        obj(obj(e['message'])?.['usage']) ??
        obj(obj(e['response'])?.['usage']) ??
        obj(e['usageMetadata']);
      if (!u) continue;
      const read =
        num(u['cache_read_input_tokens']) ??
        num(obj(u['input_tokens_details'])?.['cached_tokens']) ??
        num(obj(u['prompt_tokens_details'])?.['cached_tokens']) ??
        num(u['cached_tokens']) ??
        num(u['cachedContentTokenCount']);
      const write = num(u['cache_creation_input_tokens']);
      if (read !== null) out.read = read;
      if (write !== null) out.write = write;
    }
    return out;
  }
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;

function responseFromJson(value: unknown): TraceStep[] {
  const v = obj(value);
  if (!v) return [];
  // Anthropic message.
  if (v['type'] === 'message' || (Array.isArray(v['content']) && v['role'] === 'assistant')) {
    return anthropicBlocks(arr(v['content']));
  }
  // OpenAI Responses.
  if (Array.isArray(v['output'])) return responsesOutput(v['output']);
  // OpenAI Chat Completions.
  const message = obj(obj(arr(v['choices'])[0])?.['message']);
  if (message) {
    const steps: TraceStep[] = [];
    const reasoning = str(message['reasoning_content']) || str(message['reasoning']);
    if (reasoning) steps.push({ type: 'thinking', text: clip(reasoning) });
    const content = textOfContent(message['content']);
    if (content) steps.push({ type: 'answer', text: clip(content) });
    for (const c of arr(message['tool_calls'])) {
      const fn = obj(obj(c)?.['function']);
      if (fn) steps.push(toolStep(str(fn['name']), str(fn['arguments'])));
    }
    return steps;
  }
  // Gemini.
  if (Array.isArray(v['candidates'])) return geminiParts([v]);
  const err = obj(v['error']);
  if (err) return [{ type: 'answer', text: clip(`Error: ${str(err['message']) || asText(err)}`) }];
  return [];
}

function anthropicBlocks(blocks: unknown[]): TraceStep[] {
  const steps: TraceStep[] = [];
  for (const b of blocks) {
    const blk = obj(b);
    if (!blk) continue;
    const t = blk['type'];
    if (t === 'thinking') steps.push({ type: 'thinking', text: clip(str(blk['thinking'])) });
    else if (t === 'redacted_thinking')
      steps.push({ type: 'thinking', text: '[hidden by the provider]' });
    else if (t === 'text') steps.push({ type: 'answer', text: clip(str(blk['text'])) });
    else if (t === 'tool_use' || t === 'server_tool_use' || t === 'mcp_tool_use') {
      const name = str(blk['name']);
      steps.push(
        t === 'mcp_tool_use'
          ? {
              type: 'mcp',
              name: `${str(blk['server_name'])} · ${name}`,
              text: clip(asText(blk['input'])),
            }
          : toolStep(name, blk['input']),
      );
    }
  }
  return steps;
}

function responsesOutput(items: unknown[]): TraceStep[] {
  const steps: TraceStep[] = [];
  for (const it of items) {
    const o = obj(it);
    if (!o) continue;
    const t = str(o['type']);
    if (t === 'reasoning') {
      const text = arr(o['summary'])
        .map((s) => str(obj(s)?.['text']))
        .concat(arr(o['content']).map((c) => str(obj(c)?.['text'])))
        .filter(Boolean)
        .join('\n');
      steps.push({ type: 'thinking', text: clip(text || '[hidden by the provider]') });
    } else if (t === 'message') {
      const text = textOfContent(o['content']);
      if (text) steps.push({ type: 'answer', text: clip(text) });
    } else if (t === 'function_call') {
      steps.push(toolStep(str(o['name']), str(o['arguments'])));
    } else if (t === 'custom_tool_call') {
      steps.push(toolStep(str(o['name']), str(o['input'])));
    } else if (t === 'local_shell_call') {
      steps.push(toolStep('local_shell', obj(o['action']) ?? {}));
    } else if (t === 'mcp_call') {
      steps.push({
        type: 'mcp',
        name: `${str(o['server_label'])} · ${str(o['name'])}`,
        text: clip(str(o['arguments'])),
      });
    } else if (t.endsWith('_call')) {
      steps.push({
        type: 'tool_call',
        name: t.replace(/_call$/, ''),
        text: clip(asText(o['action'] ?? o)),
      });
    }
  }
  return steps;
}

function geminiParts(chunks: unknown[]): TraceStep[] {
  let thinking = '';
  let answer = '';
  const calls: TraceStep[] = [];
  for (const c of chunks) {
    const parts = arr(obj(obj(arr(obj(c)?.['candidates'])[0])?.['content'])?.['parts']);
    for (const p of parts) {
      const part = obj(p);
      if (!part) continue;
      if (typeof part['text'] === 'string') {
        if (part['thought'] === true) thinking += part['text'];
        else answer += part['text'];
      }
      const fc = obj(part['functionCall']);
      if (fc) calls.push(toolStep(str(fc['name']), fc['args']));
    }
  }
  const steps: TraceStep[] = [];
  if (thinking) steps.push({ type: 'thinking', text: clip(thinking) });
  if (answer) steps.push({ type: 'answer', text: clip(answer) });
  return [...steps, ...calls];
}

function responseFromStream(text: string): TraceStep[] {
  const events: Json[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]' || data[0] !== '{') continue;
    const o = obj(safeJson(data));
    if (o) events.push(o);
  }
  if (events.length === 0) return [];

  // Anthropic: content blocks built from deltas.
  if (
    events.some((e) => str(e['type']).startsWith('content_block_') || e['type'] === 'message_start')
  ) {
    const blocks: Json[] = [];
    for (const e of events) {
      const i = typeof e['index'] === 'number' ? e['index'] : -1;
      if (e['type'] === 'content_block_start') {
        blocks[i] = { ...(obj(e['content_block']) ?? {}) };
      } else if (e['type'] === 'content_block_delta' && blocks[i]) {
        const d = obj(e['delta']) ?? {};
        const b = blocks[i];
        if (d['type'] === 'thinking_delta') b['thinking'] = str(b['thinking']) + str(d['thinking']);
        else if (d['type'] === 'text_delta') b['text'] = str(b['text']) + str(d['text']);
        else if (d['type'] === 'input_json_delta')
          b['_json'] = str(b['_json']) + str(d['partial_json']);
      }
    }
    // forEach skips the gaps of blocks that never started.
    blocks.forEach((b) => {
      if (typeof b['_json'] === 'string') b['input'] = safeJson(b['_json'] || '{}') ?? b['_json'];
    });
    const steps = anthropicBlocks(blocks.filter(Boolean));
    const err = events.find((e) => e['type'] === 'error');
    if (err)
      steps.push({ type: 'answer', text: clip(`Error: ${str(obj(err['error'])?.['message'])}`) });
    return steps;
  }

  // OpenAI Responses: the finished response, or each finished item.
  const done = events.find(
    (e) => e['type'] === 'response.completed' || e['type'] === 'response.done',
  );
  const doneOutput = arr(obj(done?.['response'])?.['output']);
  if (doneOutput.length > 0) return responsesOutput(doneOutput);
  const items = events
    .filter((e) => e['type'] === 'response.output_item.done')
    .map((e) => e['item']);
  if (items.length > 0) return responsesOutput(items);

  // Gemini stream.
  if (events.some((e) => Array.isArray(e['candidates']))) return geminiParts(events);

  // OpenAI Chat Completions stream.
  let thinking = '';
  let answer = '';
  const calls: { name: string; args: string }[] = [];
  for (const e of events) {
    const delta = obj(obj(arr(e['choices'])[0])?.['delta']);
    if (!delta) continue;
    thinking += str(delta['reasoning_content']) || str(delta['reasoning']);
    answer += textOfContent(delta['content']);
    for (const c of arr(delta['tool_calls'])) {
      const call = obj(c);
      if (!call) continue;
      const i = typeof call['index'] === 'number' ? call['index'] : calls.length;
      const fn = obj(call['function']) ?? {};
      calls[i] ??= { name: '', args: '' };
      calls[i].name += str(fn['name']);
      calls[i].args += str(fn['arguments']);
    }
  }
  const steps: TraceStep[] = [];
  if (thinking) steps.push({ type: 'thinking', text: clip(thinking) });
  if (answer) steps.push({ type: 'answer', text: clip(answer) });
  calls.forEach((c) => steps.push(toolStep(c.name, c.args)));
  return steps;
}

/** Requests worth tracking: the ones that ask the model something. */
export function isModelCall(method: string, path: string): boolean {
  if (method !== 'POST') return false;
  if (/count_tokens|\/compact$|\/embeddings/.test(path)) return false;
  return /\/messages$|\/responses$|\/chat\/completions$|:(stream)?generateContent$/i.test(path);
}

// ── The agent's setup: system prompt and tools ────────────────────────────

export interface RequestContext {
  system: string | null;
  tools: TraceTool[];
}

function schemaText(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const t = asText(v);
  return t.length > TRACE_LIMITS.toolDescriptionMax
    ? `${t.slice(0, TRACE_LIMITS.toolDescriptionMax)}…`
    : t;
}

function describe(v: unknown): string {
  const t = str(v);
  return t.length > TRACE_LIMITS.toolDescriptionMax
    ? `${t.slice(0, TRACE_LIMITS.toolDescriptionMax)}…`
    : t;
}

/** A named tool, sorted into an MCP tool or an ordinary one. */
function namedTool(name: string, description: unknown, schema: unknown): TraceTool {
  if (name.startsWith('mcp__')) {
    const [, server = '', ...tool] = name.split('__');
    const out: TraceTool = {
      name: tool.join('__'),
      kind: 'mcp',
      server,
      description: describe(description),
    };
    const sc = schemaText(schema);
    if (sc !== undefined) out.schema = sc;
    return out;
  }
  const out: TraceTool = { name, kind: 'tool', description: describe(description) };
  const sc = schemaText(schema);
  if (sc !== undefined) out.schema = sc;
  return out;
}

function toolsOf(v: Json): TraceTool[] {
  const tools: TraceTool[] = [];
  for (const t of arr(v['tools'])) {
    const o = obj(t);
    if (!o) continue;
    const type = str(o['type']);
    // Gemini: one entry holds many declarations.
    const decls = arr(o['functionDeclarations'] ?? o['function_declarations']);
    if (decls.length > 0) {
      for (const d of decls) {
        const f = obj(d);
        if (f)
          tools.push(
            namedTool(
              str(f['name']),
              f['description'],
              f['parameters'] ?? f['parametersJsonSchema'],
            ),
          );
      }
      continue;
    }
    // Chat Completions: {type: "function", function: {...}}.
    const fn = obj(o['function']);
    if (fn) {
      tools.push(namedTool(str(fn['name']), fn['description'], fn['parameters']));
      continue;
    }
    // OpenAI Responses: a remote MCP server the provider calls itself.
    if (type === 'mcp') {
      const allowed = arr(o['allowed_tools']).map(str).filter(Boolean);
      tools.push({
        name: allowed.length ? allowed.join(', ') : '(all tools)',
        kind: 'mcp',
        server: str(o['server_label']) || str(o['server_url']),
        description: str(o['server_description']) || str(o['server_url']),
      });
      continue;
    }
    // Anthropic MCP connector toolsets.
    if (type === 'mcp_toolset') {
      tools.push({
        name: '(all tools)',
        kind: 'mcp',
        server: str(o['mcp_server_name']),
        description: '',
      });
      continue;
    }
    const name = str(o['name']);
    if (!name && type) {
      // The provider's own tools: web_search, local_shell, code_interpreter …
      tools.push({ name: type, kind: 'server', description: '' });
      continue;
    }
    if (!name) continue;
    if (type && type !== 'function' && type !== 'custom' && !('input_schema' in o)) {
      // Anthropic's own tools (bash_20250124, web_search_20260209 …) carry a name and a type.
      tools.push({ name, kind: 'server', description: type });
      continue;
    }
    tools.push(
      namedTool(name, o['description'], o['input_schema'] ?? o['parameters'] ?? o['format']),
    );
  }
  // Anthropic: remote MCP servers declared beside the tools.
  for (const sv of arr(v['mcp_servers'])) {
    const o = obj(sv);
    if (o && !tools.some((t) => t.kind === 'mcp' && t.server === str(o['name']))) {
      tools.push({
        name: '(all tools)',
        kind: 'mcp',
        server: str(o['name']),
        description: str(o['url']),
      });
    }
  }
  return tools.slice(0, TRACE_LIMITS.toolsMax);
}

function systemOf(v: Json): string | null {
  const parts: string[] = [];
  // Anthropic: "system" as text or blocks.
  if (typeof v['system'] === 'string') parts.push(v['system']);
  else parts.push(...arr(v['system']).map((b) => str(obj(b)?.['text'])));
  // OpenAI Responses.
  parts.push(str(v['instructions']));
  // Gemini.
  const si = obj(v['systemInstruction'] ?? v['system_instruction']);
  if (si) parts.push(...arr(si['parts']).map((p) => str(obj(p)?.['text'])));
  // Chat Completions (and Responses input): system and developer messages.
  const msgs = Array.isArray(v['messages']) ? v['messages'] : arr(v['input']);
  for (const m of msgs) {
    const o = obj(m);
    if (o && (o['role'] === 'system' || o['role'] === 'developer'))
      parts.push(textOfContent(o['content']));
  }
  const text = parts.filter(Boolean).join('\n\n');
  if (!text) return null;
  return text.length > TRACE_LIMITS.systemMax
    ? `${text.slice(0, TRACE_LIMITS.systemMax)}… [cut, ${String(text.length)} characters in all]`
    : text;
}

/** The system prompt and the tools (MCP ones included) the agent gave the model. */
export function requestContext(body: Buffer | undefined): RequestContext {
  if (!body || body.length === 0 || body[0] !== 0x7b) return { system: null, tools: [] };
  const v = obj(safeJson(body.toString('utf8')));
  if (!v) return { system: null, tools: [] };
  return { system: systemOf(v), tools: toolsOf(v) };
}

// ── Asking for readable thinking ──────────────────────────────────────────

/**
 * While the tracker is on, asks the provider to send the model's thinking as
 * readable text where it would otherwise leave it out:
 * - Claude (Opus 4.7 and newer leave thinking empty unless asked): thinking.display = "summarized".
 * - OpenAI Responses (Codex): reasoning.summary = "auto".
 * - Gemini: thinkingConfig.includeThoughts = true.
 * Only settings the agent already sent are changed, so a model that doesn't
 * think is never asked to. Returns null when nothing needs changing.
 */
export function withVisibleThinking(body: Buffer | undefined): Buffer | null {
  if (!body || body.length === 0 || body[0] !== 0x7b) return null;
  const v = obj(safeJson(body.toString('utf8')));
  if (!v) return null;
  let changed = false;
  const thinking = obj(v['thinking']);
  if (thinking && (thinking['type'] === 'adaptive' || thinking['type'] === 'enabled')) {
    if (thinking['display'] !== 'summarized') {
      thinking['display'] = 'summarized';
      changed = true;
    }
  }
  const reasoning = obj(v['reasoning']);
  if (reasoning && 'input' in v) {
    const summary = reasoning['summary'];
    if (summary === undefined || summary === null || summary === 'none') {
      reasoning['summary'] = 'auto';
      changed = true;
    }
  }
  const tc = obj(obj(v['generationConfig'])?.['thinkingConfig']);
  if (tc && tc['includeThoughts'] !== true && tc['thinkingBudget'] !== 0) {
    tc['includeThoughts'] = true;
    changed = true;
  }
  return changed ? Buffer.from(JSON.stringify(v), 'utf8') : null;
}

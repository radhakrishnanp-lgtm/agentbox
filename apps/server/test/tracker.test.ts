import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AiKeySummary,
  MachineCreated,
  TraceEntry,
  TracePage,
  TrackerStatus,
} from '@agentbox/shared';
import { agentTrace, agentTraceBlob, auditLog } from '../src/db/schema.ts';
import {
  TraceCollector,
  isModelCall,
  requestContext,
  requestSteps,
  toolStep,
  withVisibleThinking,
  withoutHiddenThinking,
} from '../src/gateway/trace.ts';
import { csvCell } from '../src/gateway/tracker.ts';
import { FakeProvider } from './helpers/fake-provider.ts';
import { Harness, RP_ID, type Browser } from './helpers/harness.ts';

const sse = (events: unknown[]) =>
  events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join('');
const buf = (v: unknown) => Buffer.from(JSON.stringify(v));

describe('reading what an agent did', () => {
  it('takes only the new user turn from a Claude Code request, with tool names', () => {
    const steps = requestSteps(
      buf({
        model: 'claude-sonnet-4-5',
        max_tokens: 100,
        system: 'You are Claude Code',
        messages: [
          { role: 'user', content: 'old prompt, saved before' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu_1',
                content: [{ type: 'text', text: 'a.txt' }],
              },
              { type: 'text', text: 'now open it' },
            ],
          },
        ],
      }),
    );
    expect(steps).toEqual([
      { type: 'tool_result', name: 'Bash', text: 'a.txt' },
      { type: 'prompt', text: 'now open it' },
    ]);
  });

  it('reads a streamed Claude answer: thinking, a command, an MCP call and text', () => {
    const c = new TraceCollector();
    c.push(
      Buffer.from(
        sse([
          { type: 'message_start', message: { usage: {} } },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking: '' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'Let me ' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'look.' },
          },
          { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
          {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'text_delta', text: 'Checking.' },
          },
          {
            type: 'content_block_start',
            index: 2,
            content_block: { type: 'tool_use', id: 't', name: 'Bash', input: {} },
          },
          {
            type: 'content_block_delta',
            index: 2,
            delta: { type: 'input_json_delta', partial_json: '{"command":' },
          },
          {
            type: 'content_block_delta',
            index: 2,
            delta: { type: 'input_json_delta', partial_json: '"git status"}' },
          },
          {
            type: 'content_block_start',
            index: 3,
            content_block: { type: 'tool_use', id: 'u', name: 'mcp__github__get_issue', input: {} },
          },
          {
            type: 'content_block_delta',
            index: 3,
            delta: { type: 'input_json_delta', partial_json: '{"number":7}' },
          },
          { type: 'message_stop' },
        ]),
      ),
    );
    expect(c.finish('text/event-stream')).toEqual([
      { type: 'thinking', text: 'Let me look.' },
      { type: 'answer', text: 'Checking.' },
      { type: 'command', name: 'Bash', text: 'git status' },
      { type: 'mcp', name: 'github · get_issue', text: '{\n  "number": 7\n}' },
    ]);
  });

  it('reads Codex (OpenAI Responses): tool output in, reasoning and a shell call out', () => {
    expect(
      requestSteps(
        buf({
          model: 'gpt-5.1-codex',
          instructions: 'x',
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'fix the test' }],
            },
            { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{}' },
            { type: 'function_call_output', call_id: 'c1', output: 'ok' },
          ],
        }),
      ),
    ).toEqual([{ type: 'tool_result', name: 'shell', text: 'ok' }]);

    const c = new TraceCollector();
    c.push(
      Buffer.from(
        sse([
          {
            type: 'response.completed',
            response: {
              output: [
                { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Run the tests.' }] },
                {
                  type: 'function_call',
                  name: 'shell',
                  arguments: JSON.stringify({ command: ['bash', '-lc', 'pnpm test'] }),
                },
              ],
            },
          },
        ]),
      ),
    );
    expect(c.finish('text/event-stream')).toEqual([
      { type: 'thinking', text: 'Run the tests.' },
      { type: 'command', name: 'shell', text: 'pnpm test' },
    ]);
  });

  it('reads a Chat Completions stream (Kimi, Grok) with a tool call', () => {
    expect(
      requestSteps(
        buf({
          model: 'kimi-for-coding',
          messages: [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'hello' },
          ],
        }),
      ),
    ).toEqual([{ type: 'prompt', text: 'hello' }]);
    const c = new TraceCollector();
    c.push(
      Buffer.from(
        sse([
          { choices: [{ delta: { reasoning_content: 'hmm' } }] },
          { choices: [{ delta: { content: 'Sure' } }] },
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { name: 'read_file', arguments: '{"pa' } }],
                },
              },
            ],
          },
          {
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] } },
            ],
          },
        ]) + 'data: [DONE]\n\n',
      ),
    );
    expect(c.finish('text/event-stream')).toEqual([
      { type: 'thinking', text: 'hmm' },
      { type: 'answer', text: 'Sure' },
      { type: 'tool_call', name: 'read_file', text: '{\n  "path": "a"\n}' },
    ]);
  });

  it('reads Gemini', () => {
    const c = new TraceCollector();
    c.push(
      buf({
        candidates: [
          {
            content: {
              parts: [
                { text: 'plan', thought: true },
                { text: 'done' },
                { functionCall: { name: 'run_shell_command', args: { command: 'ls' } } },
              ],
            },
          },
        ],
      }),
    );
    expect(c.finish('application/json')).toEqual([
      { type: 'thinking', text: 'plan' },
      { type: 'answer', text: 'done' },
      { type: 'command', name: 'run_shell_command', text: 'ls' },
    ]);
  });

  it('knows which calls ask the model something', () => {
    expect(isModelCall('POST', '/v1/messages')).toBe(true);
    expect(isModelCall('POST', '/v1/messages/count_tokens')).toBe(false);
    expect(isModelCall('POST', '/responses')).toBe(true);
    expect(isModelCall('POST', '/v1beta/models/g:streamGenerateContent')).toBe(true);
    expect(isModelCall('GET', '/v1/models')).toBe(false);
    expect(toolStep('Read', { file_path: '/a' }).type).toBe('tool_call');
  });

  it('reads the system prompt and the tools, MCP ones included, for every CLI', () => {
    const claude = requestContext(
      buf({
        model: 'claude-opus-5-5',
        system: [
          { type: 'text', text: 'You are Claude Code.' },
          { type: 'text', text: 'Be careful.' },
        ],
        tools: [
          { name: 'Bash', description: 'Run a command\nmore', input_schema: { type: 'object' } },
          { name: 'mcp__github__create_issue', description: 'Make an issue', input_schema: {} },
          { type: 'web_search_20260209', name: 'web_search' },
        ],
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(claude.system).toBe('You are Claude Code.\n\nBe careful.');
    expect(claude.tools).toEqual([
      {
        name: 'Bash',
        kind: 'tool',
        description: 'Run a command\nmore',
        schema: JSON.stringify({ type: 'object' }, null, 2),
      },
      {
        name: 'create_issue',
        kind: 'mcp',
        server: 'github',
        description: 'Make an issue',
        schema: '{}',
      },
      { name: 'web_search', kind: 'server', description: 'web_search_20260209' },
    ]);

    const codex = requestContext(
      buf({
        model: 'gpt-5-codex',
        instructions: 'You are Codex.',
        input: [
          {
            type: 'message',
            role: 'developer',
            content: [{ type: 'input_text', text: 'AGENTS.md rules' }],
          },
        ],
        tools: [
          { type: 'function', name: 'shell', description: 'Runs a command', parameters: {} },
          { type: 'mcp', server_label: 'docs', server_url: 'https://docs.example/mcp' },
          { type: 'local_shell' },
        ],
      }),
    );
    expect(codex.system).toBe('You are Codex.\n\nAGENTS.md rules');
    expect(codex.tools.map((t) => [t.kind, t.server ?? '', t.name])).toEqual([
      ['tool', '', 'shell'],
      ['mcp', 'docs', '(all tools)'],
      ['server', '', 'local_shell'],
    ]);

    const chat = requestContext(
      buf({
        model: 'kimi-k2',
        messages: [
          { role: 'system', content: 'You are Kimi.' },
          { role: 'user', content: 'hi' },
        ],
        tools: [
          { type: 'function', function: { name: 'read', description: 'Read', parameters: {} } },
        ],
      }),
    );
    expect(chat.system).toBe('You are Kimi.');
    expect(chat.tools.map((t) => t.name)).toEqual(['read']);

    const gemini = requestContext(
      buf({
        systemInstruction: { parts: [{ text: 'You are Gemini CLI.' }] },
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        tools: [{ functionDeclarations: [{ name: 'glob', description: 'Find files' }] }],
      }),
    );
    expect(gemini.system).toBe('You are Gemini CLI.');
    expect(gemini.tools.map((t) => t.name)).toEqual(['glob']);
  });

  it('asks for readable thinking only where the agent already turned thinking on', () => {
    const json = (b: Buffer | null) =>
      b ? (JSON.parse(b.toString()) as Record<string, unknown>) : null;
    expect(
      json(withVisibleThinking(buf({ thinking: { type: 'adaptive' }, messages: [] })))?.[
        'thinking'
      ],
    ).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(
      withVisibleThinking(
        buf({ thinking: { type: 'adaptive', display: 'summarized' }, messages: [] }),
      ),
    ).toBeNull();
    // No thinking asked for, or thinking switched off: left alone.
    expect(withVisibleThinking(buf({ messages: [] }))).toBeNull();
    expect(withVisibleThinking(buf({ model: 'claude-opus-4-8', messages: [] }))).toBeNull();
    // Models that always think get asked for the text even when the request says nothing.
    expect(
      json(withVisibleThinking(buf({ model: 'claude-opus-5-5', messages: [] })))?.['thinking'],
    ).toEqual({ type: 'adaptive', display: 'summarized' });
    // Claude Code's flag that hides thinking is dropped; other flags stay.
    expect(withoutHiddenThinking('oauth-2025-04-20, redact-thinking-2026-02-12,foo')).toBe(
      'oauth-2025-04-20,foo',
    );
    expect(withoutHiddenThinking('redact-thinking-2026-02-12')).toBe('');
    expect(withoutHiddenThinking('oauth-2025-04-20')).toBeNull();
    expect(withoutHiddenThinking(undefined)).toBeNull();
    expect(
      withVisibleThinking(buf({ thinking: { type: 'between_tools' }, messages: [] })),
    ).toBeNull();
    // Codex.
    expect(
      json(withVisibleThinking(buf({ input: 'hi', reasoning: { effort: 'high' } })))?.['reasoning'],
    ).toEqual({ effort: 'high', summary: 'auto' });
    expect(
      withVisibleThinking(buf({ input: 'hi', reasoning: { summary: 'detailed' } })),
    ).toBeNull();
    // Gemini.
    expect(
      json(
        withVisibleThinking(
          buf({ contents: [], generationConfig: { thinkingConfig: { thinkingBudget: -1 } } }),
        ),
      )?.['generationConfig'],
    ).toEqual({ thinkingConfig: { thinkingBudget: -1, includeThoughts: true } });
    expect(
      withVisibleThinking(
        buf({ contents: [], generationConfig: { thinkingConfig: { thinkingBudget: 0 } } }),
      ),
    ).toBeNull();
  });

  it('reads how much of the prompt came from the cache', () => {
    const claude = new TraceCollector();
    claude.push(
      Buffer.from(
        sse([
          {
            type: 'message_start',
            message: {
              usage: {
                input_tokens: 4,
                cache_read_input_tokens: 9000,
                cache_creation_input_tokens: 120,
              },
            },
          },
          { type: 'message_delta', usage: { output_tokens: 5 } },
        ]),
      ),
    );
    expect(claude.cache()).toEqual({ read: 9000, write: 120 });
    const codex = new TraceCollector();
    codex.push(
      Buffer.from(
        sse([
          {
            type: 'response.completed',
            response: {
              output: [],
              usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 7 } },
            },
          },
        ]),
      ),
    );
    expect(codex.cache()).toEqual({ read: 7, write: null });
    const gemini = new TraceCollector();
    gemini.push(buf({ candidates: [], usageMetadata: { cachedContentTokenCount: 3 } }));
    expect(gemini.cache()).toEqual({ read: 3, write: null });
  });

  it('keeps spreadsheet formulas out of the CSV', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(12)).toBe('12');
  });
});

describe('agent tracker', () => {
  let h: Harness;
  let laptop: Browser;
  let provider: FakeProvider;

  beforeEach(async () => {
    h = await Harness.create();
    laptop = h.browser();
    await h.completeSetup(laptop);
    provider = await new FakeProvider().start();
  });
  afterEach(async () => {
    await h.close();
    await provider.stop();
  });

  async function machine(): Promise<string> {
    await h.reauth(laptop);
    const key = (
      await laptop.post('/api/gateway/keys', {
        preset: 'anthropic',
        name: 'Claude API',
        slug: 'anthropic',
        secret: 'sk-ant-api03-test-0000000000000000000000000000000000000',
        upstream: provider.url,
      })
    ).json<AiKeySummary>();
    const res = await laptop.post('/api/gateway/machines', {
      name: 'A6000',
      keyIds: [key.id],
      dailyTokenLimit: null,
    });
    return res.json<MachineCreated>().pass;
  }

  const ask = (pass: string, prompt: string, extra: Record<string, unknown> = {}) =>
    h.app.inject({
      method: 'POST',
      url: '/gw/anthropic/v1/messages',
      headers: {
        host: RP_ID,
        'x-forwarded-for': '198.51.100.50',
        'x-forwarded-proto': 'https',
        'content-type': 'application/json',
        'x-api-key': pass,
        'anthropic-beta': 'redact-thinking-2026-02-12,foo-2026-01-01',
      },
      payload: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 64,
        stream: true,
        messages: [{ role: 'user', content: prompt }],
        ...extra,
      }),
    });

  const send = (method: 'PUT' | 'PATCH', url: string, payload: Record<string, unknown>) =>
    laptop.request({ method, url, payload });

  it('is off by default and saves nothing until you turn it on', async () => {
    const pass = await machine();
    expect((await laptop.get('/api/tracker')).json<TrackerStatus>()).toMatchObject({
      enabled: false,
      entries: 0,
    });
    expect((await ask(pass, 'secret plan')).statusCode).toBe(200);
    expect(h.services.db.select().from(agentTrace).all()).toHaveLength(0);
  });

  it('records prompts, thinking, commands and answers, and lets you manage them', async () => {
    const pass = await machine();
    // Turning it on needs a fresh passkey check.
    h.clock.advance(6 * 60_000);
    await h.signInWithPasskey(laptop);
    h.clock.advance(6 * 60_000);
    const refused = await send('PUT', '/api/tracker', { enabled: true });
    expect(refused.json().error.code).toBe('fresh_auth_required');
    await h.reauth(laptop);
    expect(
      (await send('PUT', '/api/tracker', { enabled: true })).json<TrackerStatus>().enabled,
    ).toBe(true);

    provider.sse = sse([
      { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'list files' },
      },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 't', name: 'Bash', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"command":"ls -la"}' },
      },
      { type: 'message_delta', usage: { output_tokens: 9 } },
    ]);
    expect((await ask(pass, 'what is in this folder?')).statusCode).toBe(200);
    expect((await ask(pass, 'second question')).statusCode).toBe(200);

    // Saved encrypted.
    const raw = h.services.db.select().from(agentTrace).all();
    expect(raw).toHaveLength(2);
    expect(raw[0]?.eventsEnc).not.toContain('ls -la');

    const page = (await laptop.get('/api/tracker/entries')).json<TracePage>();
    expect(page.entries.map((e) => e.preview)).toEqual([
      'second question',
      'what is in this folder?',
    ]);
    const first = page.entries[1]!;
    expect(first).toMatchObject({
      machineName: 'A6000',
      model: 'claude-sonnet-4-5',
      counts: { prompt: 1, thinking: 1, command: 1 },
      inputTokens: 5,
      outputTokens: 9,
    });
    const entry = (await laptop.get(`/api/tracker/entries/${first.id}`)).json<TraceEntry>();
    expect(entry.steps).toEqual([
      { type: 'prompt', text: 'what is in this folder?' },
      { type: 'thinking', text: 'list files' },
      { type: 'command', name: 'Bash', text: 'ls -la' },
    ]);

    // Edit the note.
    const noted = await send('PATCH', `/api/tracker/entries/${first.id}`, { note: 'check this' });
    expect(noted.json<TraceEntry>().note).toBe('check this');

    // Export the selected entry (needs the fresh check, which is still recent).
    const exported = await laptop.post('/api/tracker/export', { ids: [first.id] });
    expect(exported.statusCode, exported.body).toBe(200);
    const { csv, entries } = exported.json<{ csv: string; entries: number }>();
    expect(entries).toBe(1);
    expect(csv.split('\r\n')[0]).toContain('time,entry,computer,address,key,cli,model');
    expect(csv).toContain('command,Bash,ls -la');
    expect(csv).toContain('check this');
    expect((await laptop.post('/api/tracker/export', { ids: 'all' })).json().entries).toBe(2);

    // Turning it off keeps the history.
    await send('PUT', '/api/tracker', { enabled: false });
    await ask(pass, 'not saved');
    expect((await laptop.get('/api/tracker')).json<TrackerStatus>()).toMatchObject({
      enabled: false,
      entries: 2,
    });

    // Delete one, then all.
    expect((await laptop.post('/api/tracker/delete', { ids: [first.id] })).json().deleted).toBe(1);
    expect((await laptop.post('/api/tracker/delete', { ids: 'all' })).json().deleted).toBe(1);
    expect((await laptop.get('/api/tracker')).json<TrackerStatus>().entries).toBe(0);

    const actions = h.services.db
      .select()
      .from(auditLog)
      .all()
      .map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'tracker.enabled',
        'tracker.exported',
        'tracker.disabled',
        'tracker.deleted',
      ]),
    );
  });

  it('saves the system prompt and tools once, shows the thinking, and counts the cache', async () => {
    const pass = await machine();
    const setup = {
      system: [{ type: 'text', text: 'You are Claude Code. Secret instructions.' }],
      tools: [
        { name: 'Bash', description: 'Run a command', input_schema: { type: 'object' } },
        { name: 'mcp__github__create_issue', description: 'Make an issue', input_schema: {} },
      ],
      thinking: { type: 'adaptive' },
    };
    // Off: the request goes out exactly as the CLI sent it.
    await ask(pass, 'before', setup);
    expect(JSON.parse(provider.seen.at(-1)!.body).thinking).toEqual({ type: 'adaptive' });
    expect(provider.seen.at(-1)!.headers['anthropic-beta']).toBe(
      'redact-thinking-2026-02-12,foo-2026-01-01',
    );

    await h.reauth(laptop);
    await send('PUT', '/api/tracker', { enabled: true });
    // Both extra switches are off by default: nothing of the setup is saved.
    expect((await laptop.get('/api/tracker')).json<TrackerStatus>()).toMatchObject({
      system: false,
      tools: false,
    });
    await ask(pass, 'without setup', setup);
    const bare = (await laptop.get('/api/tracker/entries')).json<TracePage>().entries[0]!;
    expect(bare).toMatchObject({ hasSystem: false, toolCount: 0 });
    expect(h.services.db.select().from(agentTraceBlob).all()).toHaveLength(0);
    await laptop.post('/api/tracker/delete', { ids: 'all' });

    // Turning them on needs the fresh check too.
    h.clock.advance(6 * 60_000);
    await h.signInWithPasskey(laptop);
    h.clock.advance(6 * 60_000);
    expect((await send('PUT', '/api/tracker', { system: true })).json().error.code).toBe(
      'fresh_auth_required',
    );
    await h.reauth(laptop);
    expect(
      (await send('PUT', '/api/tracker', { system: true, tools: true })).json<TrackerStatus>(),
    ).toMatchObject({ enabled: true, system: true, tools: true });
    expect((await ask(pass, 'first', setup)).statusCode).toBe(200);
    expect((await ask(pass, 'second', setup)).statusCode).toBe(200);
    // On: the provider is asked for readable thinking.
    expect(JSON.parse(provider.seen.at(-1)!.body).thinking).toEqual({
      type: 'adaptive',
      display: 'summarized',
    });
    expect(provider.seen.at(-1)!.headers['anthropic-beta']).toBe('foo-2026-01-01');

    const page = (await laptop.get('/api/tracker/entries')).json<TracePage>();
    expect(page.entries[0]).toMatchObject({
      preview: 'second',
      hasSystem: true,
      toolCount: 2,
      mcpToolCount: 1,
      cacheReadTokens: 3,
    });
    const entry = (
      await laptop.get(`/api/tracker/entries/${page.entries[0]!.id}`)
    ).json<TraceEntry>();
    expect(entry.system).toBe('You are Claude Code. Secret instructions.');
    expect(entry.tools.map((t) => [t.kind, t.server ?? '', t.name])).toEqual([
      ['tool', '', 'Bash'],
      ['mcp', 'github', 'create_issue'],
    ]);
    // One saved copy each, encrypted, shared by both entries.
    const blobs = h.services.db.select().from(agentTraceBlob).all();
    expect(blobs).toHaveLength(2);
    expect(blobs.map((b) => b.enc).join()).not.toContain('Secret instructions');
    expect(blobs.map((b) => b.hash).join()).not.toContain('Secret');

    const { csv } = (await laptop.post('/api/tracker/export', { ids: 'all' })).json<{
      csv: string;
    }>();
    expect(csv.split('\r\n')[0]).toContain('cache_read_tokens,cache_write_tokens');
    expect(csv).toContain('system,,You are Claude Code. Secret instructions.');
    expect(csv).toContain('MCP github · create_issue: Make an issue');
    expect(csv).toContain(`system,,(same as entry ${page.entries[1]!.id})`);

    // Deleting the entries deletes the copies too.
    await laptop.post('/api/tracker/delete', { ids: 'all' });
    expect(h.services.db.select().from(agentTraceBlob).all()).toHaveLength(0);
  });

  it('saves only the system prompt when only that switch is on', async () => {
    const pass = await machine();
    await h.reauth(laptop);
    await send('PUT', '/api/tracker', { enabled: true, system: true });
    await ask(pass, 'hello', {
      system: 'You are Claude Code.',
      tools: [{ name: 'mcp__github__create_issue', description: 'x', input_schema: {} }],
    });
    const e = (await laptop.get('/api/tracker/entries')).json<TracePage>().entries[0]!;
    expect(e).toMatchObject({ hasSystem: true, toolCount: 0, mcpToolCount: 0 });
    const entry = (await laptop.get(`/api/tracker/entries/${e.id}`)).json<TraceEntry>();
    expect(entry.system).toBe('You are Claude Code.');
    expect(entry.tools).toEqual([]);
    // Turning a switch off needs no fresh check.
    h.clock.advance(6 * 60_000);
    await h.signInWithPasskey(laptop);
    h.clock.advance(6 * 60_000);
    const off = await send('PUT', '/api/tracker', { system: false });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json<TrackerStatus>()).toMatchObject({ enabled: true, system: false });
  });

  it('filters by computer, address and model, and "all" follows the filter', async () => {
    const pass = await machine();
    await h.reauth(laptop);
    await send('PUT', '/api/tracker', { enabled: true });
    const from = (ip: string, prompt: string, model: string) =>
      h.app.inject({
        method: 'POST',
        url: '/gw/anthropic/v1/messages',
        headers: {
          host: RP_ID,
          'x-forwarded-for': ip,
          'x-forwarded-proto': 'https',
          'content-type': 'application/json',
          'x-api-key': pass,
        },
        payload: JSON.stringify({
          model,
          max_tokens: 8,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
    expect((await from('198.51.100.50', 'a', 'claude-sonnet-4-5')).statusCode).toBe(200);
    expect((await from('198.51.100.50', 'b', 'claude-opus-5-5')).statusCode).toBe(200);
    // The machine is locked to its first address, so a second one must be allowed first.
    const page0 = (await laptop.get('/api/tracker/entries')).json<TracePage>();
    const machineId = page0.entries[0]!.machineId;
    const opts = (await laptop.get('/api/tracker/filters')).json<{
      machines: { id: string; name: string }[];
      ips: string[];
      models: string[];
    }>();
    expect(opts).toEqual({
      machines: [{ id: machineId, name: 'A6000' }],
      ips: ['198.51.100.50'],
      models: ['claude-opus-5-5', 'claude-sonnet-4-5'],
    });
    const list = async (q: string) =>
      (await laptop.get(`/api/tracker/entries?${q}`))
        .json<TracePage>()
        .entries.map((e) => e.preview);
    expect(await list('model=claude-opus-5-5')).toEqual(['b']);
    expect(await list(`machineId=${machineId}&ip=198.51.100.50`)).toEqual(['b', 'a']);
    expect(await list('ip=203.0.113.9')).toEqual([]);
    expect((await laptop.get('/api/tracker/entries')).json<TracePage>().entries[0]!.ip).toBe(
      '198.51.100.50',
    );

    // Export and delete "all" with a filter touch only the matching entries.
    const exported = await laptop.post('/api/tracker/export', {
      ids: 'all',
      filter: { model: 'claude-sonnet-4-5' },
    });
    expect(exported.json().entries).toBe(1);
    expect(exported.json<{ csv: string }>().csv.split('\r\n')[0]).toContain('computer,address,key');
    const deleted = await laptop.post('/api/tracker/delete', {
      ids: 'all',
      filter: { model: 'claude-sonnet-4-5' },
    });
    expect(deleted.json().deleted).toBe(1);
    expect(await list('')).toEqual(['b']);
  });

  it('sends the request unchanged when the provider refuses the thinking setting', async () => {
    const pass = await machine();
    await h.reauth(laptop);
    await send('PUT', '/api/tracker', { enabled: true });
    provider.rejectDisplay = true;
    const thinking = { thinking: { type: 'adaptive' } };
    const first = await ask(pass, 'one', thinking);
    expect(first.statusCode, first.body).toBe(200);
    const before = provider.seen.length;
    expect((await ask(pass, 'two', thinking)).statusCode).toBe(200);
    // Not tried again for this key: one request, unchanged.
    expect(provider.seen.length - before).toBe(1);
    expect(JSON.parse(provider.seen.at(-1)!.body).thinking).toEqual({ type: 'adaptive' });
    expect((await laptop.get('/api/tracker')).json<TrackerStatus>().entries).toBe(2);
  });

  it('is only for signed-in devices', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/tracker/entries' });
    expect(res.statusCode).toBe(401);
  });
});

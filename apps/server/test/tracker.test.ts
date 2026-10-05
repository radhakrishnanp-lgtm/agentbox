import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AiKeySummary,
  MachineCreated,
  TraceEntry,
  TracePage,
  TrackerStatus,
} from '@agentbox/shared';
import { agentTrace, auditLog } from '../src/db/schema.ts';
import { TraceCollector, isModelCall, requestSteps, toolStep } from '../src/gateway/trace.ts';
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

  const ask = (pass: string, prompt: string) =>
    h.app.inject({
      method: 'POST',
      url: '/gw/anthropic/v1/messages',
      headers: {
        host: RP_ID,
        'x-forwarded-for': '198.51.100.50',
        'x-forwarded-proto': 'https',
        'content-type': 'application/json',
        'x-api-key': pass,
      },
      payload: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 64,
        stream: true,
        messages: [{ role: 'user', content: prompt }],
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
    expect(csv.split('\r\n')[0]).toContain('time,entry,computer,key,cli,model');
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

  it('is only for signed-in devices', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/tracker/entries' });
    expect(res.statusCode).toBe(401);
  });
});

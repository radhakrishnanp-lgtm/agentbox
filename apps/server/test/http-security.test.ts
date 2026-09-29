import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness, ORIGIN, type Browser } from './helpers/harness.ts';

let h: Harness;
let b: Browser;

beforeEach(async () => {
  h = await Harness.create();
  b = h.browser();
  await h.completeSetup(b);
});
afterEach(() => h.close());

describe('CSRF defences', () => {
  const unsafe = (headers: Record<string, string | undefined>) =>
    b.request({
      method: 'POST',
      url: '/api/auth/logout',
      raw: true,
      headers: headers,
    });

  it('blocks a POST with no Origin (e.g. a scripted cross-site form)', async () => {
    const res = await unsafe({ 'x-agentbox': '1' });
    expect(res.statusCode).toBe(403);
    expect((await b.get('/api/security')).statusCode).toBe(200); // still signed in
  });

  it('blocks a POST from another origin', async () => {
    const res = await unsafe({ origin: 'https://evil.example', 'x-agentbox': '1' });
    expect(res.statusCode).toBe(403);
  });

  it('blocks a cross-site request even with a spoofed matching Origin', async () => {
    const res = await unsafe({ origin: ORIGIN, 'sec-fetch-site': 'cross-site', 'x-agentbox': '1' });
    expect(res.statusCode).toBe(403);
  });

  it('requires the X-Agentbox header (forces a CORS preflight cross-site)', async () => {
    const res = await unsafe({ origin: ORIGIN, 'sec-fetch-site': 'same-origin' });
    expect(res.statusCode).toBe(403);
  });

  it('rejects form-encoded bodies', async () => {
    const res = await b.request({
      method: 'POST',
      url: '/api/auth/recovery',
      payload: 'code=123456',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('headers', () => {
  it('sends strict security headers', async () => {
    const res = await b.get('/api/auth/state');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect(res.headers['strict-transport-security']).toContain('max-age=63072000');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-robots-tag']).toContain('noindex');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sets hardened cookies', async () => {
    const fresh = h.browser('198.51.100.20');
    const res = await h.signInWithPasskey(fresh);
    const cookies = [res.headers['set-cookie']].flat().join('\n');
    expect(cookies).toContain('__Host-agentbox_dev=');
    for (const line of [res.headers['set-cookie']].flat()) {
      expect(line).toMatch(/HttpOnly/i);
      expect(line).toMatch(/Secure/i);
      expect(line).toMatch(/SameSite=Strict/i);
      expect(line).toMatch(/Path=\//);
      expect(line).not.toMatch(/Domain=/i);
    }
  });
});

describe('errors', () => {
  it('returns one error shape with a request id and no internals', async () => {
    const res = await b.post('/api/auth/recovery', { code: 'abc' });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('bad_request');
    expect(body.error.requestId).toBe(res.headers['x-request-id']);
    expect(JSON.stringify(body)).not.toMatch(/stack|at .*\.ts/);
  });

  it('rejects oversized bodies', async () => {
    const res = await b.post('/api/auth/recovery', { code: 'x'.repeat(100_000) });
    expect(res.statusCode).toBe(413);
  });

  it('answers unknown API paths with a JSON 404', async () => {
    const res = await b.get('/api/nope');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('health check reveals nothing but ok', async () => {
    const res = await h.browser().get('/healthz');
    expect(res.json()).toEqual({ ok: true });
  });
});

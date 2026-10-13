import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, readConfig, validateMessages } from '../server/server.js';

const silent = { error() {}, log() {} };

// A fake Anthropic API: first asks to save details and estimate, then answers.
function fakeAnthropic() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const lastUser = body.messages.at(-1);
    const sawToolResults = Array.isArray(lastUser.content) && lastUser.content[0]?.type === 'tool_result';
    const payload = sawToolResults
      ? { stop_reason: 'end_turn', content: [{ type: 'text', text: 'About £2,990 to £7,230 after the grant.' }] }
      : {
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'Let me work that out.' },
          { type: 'tool_use', id: 't1', name: 'update_home_details', input: { place: 'LE2 3WS', propertyType: 'semi_detached', bedrooms: 3, currentHeating: 'gas', ownership: 'owner_occupier' } },
          { type: 'tool_use', id: 't2', name: 'estimate_heat_pump', input: {} },
        ],
      };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

async function withServer(env, opts, fn) {
  const cfg = readConfig({ ANTHROPIC_API_KEY: 'test-key', ALLOWED_ORIGINS: 'https://fidesq.com', TRUST_PROXY: 'false', ...env });
  const server = createServer(cfg, { log: silent, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const chat = (base, body, headers = {}) => fetch(`${base}/api/chat`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const HELLO = { messages: [{ role: 'user', content: '3 bed semi, LE2 3WS, gas, we own it' }], details: {} };

test('chat runs the tool loop and returns details, checks and the answer', async () => {
  const api = fakeAnthropic();
  await withServer({}, { fetchImpl: api.fetchImpl }, async (base) => {
    const res = await chat(base, HELLO);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.text, 'About £2,990 to £7,230 after the grant.');
    assert.equal(data.estimated, true);
    assert.equal(data.details.place, 'LE2', 'only the outward code is kept');
    assert.equal(data.details.nation, 'england');
    assert.ok(data.checks.length >= 3);

    assert.equal(api.calls.length, 2);
    const [first, second] = api.calls;
    assert.equal(first.headers['x-api-key'], 'test-key');
    assert.match(first.body.system, /heat pump cost assistant/);
    assert.deepEqual(first.body.tools.map((t) => t.name), ['update_home_details', 'estimate_heat_pump', 'compare_scenario']);
    const results = second.body.messages.at(-1).content;
    assert.equal(results.length, 2);
    assert.equal(JSON.parse(results[1].content).installAfterGrant.low, 2990);
  });
});

test('the API key never reaches the browser', async () => {
  const api = fakeAnthropic();
  await withServer({}, { fetchImpl: api.fetchImpl }, async (base) => {
    const text = await (await chat(base, HELLO)).text();
    assert.doesNotMatch(text, /test-key/);
    for (const p of ['/', '/app.js', '/shared/agent-tools.js']) {
      assert.doesNotMatch(await (await fetch(base + p)).text(), /test-key/);
    }
  });
});

test('validation', () => {
  const cfg = { maxMessageChars: 10, maxTurns: 3 };
  assert.equal(validateMessages([{ role: 'user', content: 'hi' }], cfg), null);
  assert.match(validateMessages([], cfg), /non-empty/);
  assert.match(validateMessages([{ role: 'system', content: 'x' }], cfg), /role/);
  assert.match(validateMessages([{ role: 'user', content: 'x'.repeat(11) }], cfg), /too long/);
  assert.match(validateMessages([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }], cfg), /alternate/);
  assert.match(validateMessages([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], cfg), /end with a user/);
  assert.match(validateMessages(Array(5).fill({ role: 'user', content: 'a' }), cfg), /too long/);
});

test('bad requests are refused before calling Claude', async () => {
  const api = fakeAnthropic();
  await withServer({}, { fetchImpl: api.fetchImpl }, async (base) => {
    assert.equal((await chat(base, { messages: 'hi' })).status, 400);
    const bad = await fetch(`${base}/api/chat`, { method: 'POST', body: '{not json' });
    assert.equal(bad.status, 400);
    const huge = await fetch(`${base}/api/chat`, { method: 'POST', body: JSON.stringify({ x: 'a'.repeat(70_000) }) });
    assert.equal(huge.status, 413);
    assert.equal((await fetch(`${base}/api/chat`)).status, 405);
    assert.equal(api.calls.length, 0);
  });
});

test('CORS: fidesq.com allowed, other sites refused', async () => {
  const api = fakeAnthropic();
  await withServer({}, { fetchImpl: api.fetchImpl }, async (base) => {
    const pre = await fetch(`${base}/api/chat`, { method: 'OPTIONS', headers: { origin: 'https://fidesq.com' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://fidesq.com');
    const ok = await chat(base, HELLO, { origin: 'https://fidesq.com' });
    assert.equal(ok.status, 200);
    const evil = await chat(base, HELLO, { origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
  });
});

test('rate limit per visitor', async () => {
  const api = fakeAnthropic();
  await withServer({ RATE_LIMIT_PER_HOUR: '2' }, { fetchImpl: api.fetchImpl }, async (base) => {
    assert.equal((await chat(base, HELLO)).status, 200);
    assert.equal((await chat(base, HELLO)).status, 200);
    const third = await chat(base, HELLO);
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers.get('retry-after')) > 0);
  });
});

test('Anthropic errors become a friendly message, details stay server-side', async () => {
  const fetchImpl = async () => new Response('{"error":{"message":"secret internal detail"}}', { status: 500 });
  await withServer({}, { fetchImpl }, async (base) => {
    const res = await chat(base, HELLO);
    assert.equal(res.status, 502);
    const text = await res.text();
    assert.doesNotMatch(text, /secret internal detail/);
    assert.match(text, /use the form/);
  });
});

test('no API key: chat is off but the page loads', async () => {
  await withServer({ ANTHROPIC_API_KEY: '' }, {}, async (base) => {
    assert.equal((await chat(base, HELLO)).status, 503);
    assert.equal((await fetch(base + '/')).status, 200);
  });
});

test('static files and security headers', async () => {
  await withServer({}, {}, async (base) => {
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await fetch(base + '/core/heat-pump-core.js')).status, 200);
    assert.equal((await fetch(base + '/core/load-core.js')).status, 404, 'only the browser core is served');
    assert.equal((await fetch(base + '/shared/place.js')).status, 200);
    assert.equal((await fetch(base + '/%2e%2e/package.json')).status, 404);
    assert.equal((await fetch(base + '/../server/server.js')).status, 404);
    assert.equal((await fetch(base + '/healthz')).status, 200);
  });
});

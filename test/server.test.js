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
    const payload = body.tool_choice?.name === 'ask_visitor'
      ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'q1', name: 'ask_visitor', input: { field: 'annualHeatingCostGbp', question: 'Roughly what do you spend a year on heating?' } }] }
      : sawToolResults
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

    // Saved details leave the optional yearly spend missing, so the loop makes it ask.
    assert.equal(api.calls.length, 3);
    assert.equal(data.question.field, 'annualHeatingCostGbp');
    assert.deepEqual(data.asked, { annualHeatingCostGbp: 1 });
    const [first, second] = api.calls;
    assert.equal(first.headers['x-api-key'], 'test-key');
    assert.match(first.body.system, /heat pump cost assistant/);
    assert.deepEqual(first.body.tools.map((t) => t.name), ['update_home_details', 'estimate_heat_pump', 'compare_scenario', 'ask_visitor']);
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

test('a Codespace allows its own forwarded address', () => {
  const cfg = readConfig({ CODESPACE_NAME: 'orange-x', GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev', ALLOWED_ORIGINS: 'https://fidesq.com/' });
  assert.deepEqual(cfg.allowedOrigins, ['https://fidesq.com', 'https://orange-x-3000.app.github.dev']);
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

test('behind a proxy, the limit follows the address the proxy saw, not a spoofed one', async () => {
  const api = fakeAnthropic();
  await withServer({ RATE_LIMIT_PER_HOUR: '1', TRUST_PROXY: 'true' }, { fetchImpl: api.fetchImpl }, async (base) => {
    // The proxy appends the real address last; a visitor can only add entries before it.
    assert.equal((await chat(base, HELLO, { 'x-forwarded-for': '1.1.1.1, 203.0.113.7' })).status, 200);
    assert.equal((await chat(base, HELLO, { 'x-forwarded-for': '9.9.9.9, 203.0.113.7' })).status, 429, 'spoofing the first entry must not reset the limit');
    assert.equal((await chat(base, HELLO, { 'x-forwarded-for': '203.0.113.8' })).status, 200, 'a different visitor has their own limit');
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
    assert.equal((await fetch(base + '/package.json')).status, 404, 'project files are never served');
    assert.equal((await fetch(base + '/.env')).status, 404);
    assert.equal((await fetch(base + '/')).headers.get('x-powered-by'), null);
  });
});

// ── The question loop ─────────────────────────────────────────

import { runChatTurn } from '../server/agent.js';
import { loadCore } from '../core/load-core.js';

const loopCore = loadCore();
const ok = (payload) => new Response(JSON.stringify(payload), { status: 200 });
const INVERNESS_SAYS = [{ role: 'user', content: 'Detached bungalow near Inverness on oil, no mains gas' }];
const recordInverness = {
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: 'u1', name: 'update_home_details', input: { place: 'Inverness', nation: 'scotland', propertyType: 'bungalow', currentHeating: 'oil', hasMainsGas: false } }],
};

/** A fake API that plays back scripted replies and records each request. */
function scripted(replies) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    const next = replies[calls.length - 1];
    if (!next) throw new Error(`unexpected call ${calls.length}`);
    return ok(typeof next === 'function' ? next(calls.at(-1)) : next);
  };
  return { calls, fetchImpl };
}

test('loop: the assistant asks the next missing detail and the turn ends there', async () => {
  const api = scripted([
    recordInverness,
    {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Thanks, Inverness noted. The Home Energy Scotland grant could apply.' },
        { type: 'tool_use', id: 'a1', name: 'ask_visitor', input: { field: 'bedrooms', question: 'How many bedrooms does the bungalow have?' } },
      ],
    },
  ]);
  const r = await runChatTurn({ core: loopCore, messages: INVERNESS_SAYS, details: {}, asked: {}, apiKey: 'k', model: 'm', fetchImpl: api.fetchImpl });
  assert.equal(api.calls.length, 2, 'no further call after the question');
  assert.equal(r.question.field, 'bedrooms');
  assert.equal(r.question.question, 'How many bedrooms does the bungalow have?');
  assert.equal(r.question.replies.length, 5);
  assert.deepEqual(r.asked, { bedrooms: 1 });
  assert.match(r.text, /Inverness noted/);
  assert.equal(r.details.nation, 'scotland');
});

test('loop: ending a turn with gaps and no question triggers a forced ask_visitor round', async () => {
  const api = scripted([
    recordInverness,
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Thanks, I have noted your bungalow in Inverness.' }] },
    (body) => {
      assert.deepEqual(body.tool_choice, { type: 'tool', name: 'ask_visitor' }, 'the nudge forces a question');
      assert.match(body.messages.at(-1).content, /still missing.*bedrooms/);
      return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'a1', name: 'ask_visitor', input: { field: 'bedrooms', question: 'How many bedrooms?' } }] };
    },
  ]);
  const r = await runChatTurn({ core: loopCore, messages: INVERNESS_SAYS, details: {}, apiKey: 'k', model: 'm', fetchImpl: api.fetchImpl });
  assert.equal(api.calls.length, 3);
  assert.equal(r.text, 'Thanks, I have noted your bungalow in Inverness.');
  assert.equal(r.question.field, 'bedrooms');
});

test('loop: if the assistant still asks nothing, a fixed question fills the gap', async () => {
  const api = scripted([
    recordInverness,
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Noted.' }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Noted.' }] },
  ]);
  const r = await runChatTurn({ core: loopCore, messages: INVERNESS_SAYS, details: {}, apiKey: 'k', model: 'm', fetchImpl: api.fetchImpl });
  assert.equal(r.question.field, 'bedrooms');
  assert.equal(r.question.question, 'How many bedrooms does it have?');
  assert.deepEqual(r.asked, { bedrooms: 1 });
});

test('loop: once optional questions are used up, it stops asking', async () => {
  const complete = { nation: 'england', propertyType: 'semi_detached', bedrooms: 3, currentHeating: 'gas' };
  const api = scripted([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'It costs about the same to run as gas.' }] }]);
  const r = await runChatTurn({
    core: loopCore, messages: [{ role: 'user', content: 'Is it cheaper than gas?' }],
    details: complete, asked: { ownership: 2, annualHeatingCostGbp: 1 }, apiKey: 'k', model: 'm', fetchImpl: api.fetchImpl,
  });
  assert.equal(api.calls.length, 1, 'no nudge when nothing is left to ask');
  assert.equal(r.question, null);
});

test('loop: a second question in one turn is refused', async () => {
  const api = scripted([{
    stop_reason: 'tool_use',
    content: [
      { type: 'tool_use', id: 'a1', name: 'ask_visitor', input: { field: 'place', question: 'Where is it?' } },
      { type: 'tool_use', id: 'a2', name: 'ask_visitor', input: { field: 'bedrooms', question: 'How many bedrooms?' } },
    ],
  }]);
  const r = await runChatTurn({ core: loopCore, messages: [{ role: 'user', content: 'hi' }], details: {}, apiKey: 'k', model: 'm', fetchImpl: api.fetchImpl });
  assert.equal(r.question.field, 'place');
  assert.deepEqual(r.asked, { place: 1 });
});

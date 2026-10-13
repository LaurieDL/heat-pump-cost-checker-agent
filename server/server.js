// Heat pump cost checker agent: serves the page and POST /api/chat.
// Zero dependencies. Configure with environment variables (see .env.example).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { loadCore } from '../core/load-core.js';
import { runChatTurn, AgentError } from './agent.js';
import { createRateLimiter } from './rate-limit.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Only these folders are ever served, each under its own URL prefix.
const STATIC_ROOTS = [
  { prefix: '/shared/', dir: path.join(ROOT, 'shared') },
  { prefix: '/core/', dir: path.join(ROOT, 'core'), only: ['heat-pump-core.js'] },
  { prefix: '/', dir: path.join(ROOT, 'public') },
];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; '),
};

export function readConfig(env = process.env) {
  const int = (v, d) => (Number.isFinite(Number.parseInt(v, 10)) ? Number.parseInt(v, 10) : d);
  return {
    port: int(env.PORT, 3000),
    apiKey: env.ANTHROPIC_API_KEY ?? '',
    model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    trustProxy: env.TRUST_PROXY !== 'false',
    ratePerHour: int(env.RATE_LIMIT_PER_HOUR, 40),
    globalPerDay: int(env.GLOBAL_LIMIT_PER_DAY, 3000),
    maxMessageChars: int(env.MAX_MESSAGE_CHARS, 1200),
    maxTurns: int(env.MAX_TURNS, 30),
    maxToolRounds: int(env.MAX_TOOL_ROUNDS, 5),
    maxTokens: int(env.MAX_OUTPUT_TOKENS, 1024),
  };
}

const MAX_BODY_BYTES = 64 * 1024;

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...(isJson ? { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } : {}),
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

/** Validate the chat history the page sends. Returns an error string or null. */
export function validateMessages(messages, { maxMessageChars, maxTurns }) {
  if (!Array.isArray(messages) || messages.length === 0) return 'messages must be a non-empty array';
  if (messages.length > maxTurns) return `Conversation is too long (max ${maxTurns} messages). Please start again.`;
  for (const [i, m] of messages.entries()) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return `messages[${i}].role must be user or assistant`;
    if (typeof m.content !== 'string' || !m.content.trim()) return `messages[${i}].content must be text`;
    if (m.content.length > (m.role === 'user' ? maxMessageChars : 8000)) return `messages[${i}] is too long`;
    if (i > 0 && messages[i - 1].role === m.role) return 'messages must alternate between user and assistant';
  }
  if (messages[0].role !== 'user' || messages.at(-1).role !== 'user') return 'messages must start and end with a user message';
  return null;
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    // Railway's edge appends the real client address as the LAST entry; earlier entries can be spoofed.
    const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (fwd.length) return fwd.at(-1);
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function corsHeaders(origin, cfg) {
  if (!origin || !cfg.allowedOrigins.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

function isSameOrigin(req, origin) {
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, { error: 'Bad path' });
  }
  if (pathname === '/') pathname = '/index.html';
  for (const { prefix, dir, only } of STATIC_ROOTS) {
    if (!pathname.startsWith(prefix)) continue;
    const rel = pathname.slice(prefix.length);
    if (only && !only.includes(rel)) continue;
    const file = path.join(dir, rel);
    if (!file.startsWith(dir + path.sep)) return send(res, 404, 'Not found', { 'content-type': 'text/plain' });
    try {
      const body = await readFile(file);
      const type = TYPES[path.extname(file)];
      if (!type) continue;
      return send(res, 200, body, { 'content-type': type, 'cache-control': 'no-cache' });
    } catch {
      // fall through to the next root
    }
  }
  return send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' });
}

export function createServer(cfg = readConfig(), { core = loadCore(), fetchImpl = fetch, now = () => Date.now(), log = console } = {}) {
  const perIp = createRateLimiter({ limit: cfg.ratePerHour, windowMs: 60 * 60 * 1000, now });
  const global = createRateLimiter({ limit: cfg.globalPerDay, windowMs: 24 * 60 * 60 * 1000, now });

  async function handleChat(req, res, cors) {
    if (!cfg.apiKey) return send(res, 503, { error: 'The assistant is not configured yet.' }, cors);

    const ip = clientIp(req, cfg.trustProxy);
    const mine = perIp.take(ip);
    if (!mine.allowed) {
      return send(res, 429, { error: "You've sent a lot of messages. Please try again later, or use the form." }, { ...cors, 'retry-after': String(mine.retryAfterSeconds) });
    }
    if (!global.take('all').allowed) {
      return send(res, 503, { error: 'The assistant is busy today. Please use the form for now.' }, cors);
    }

    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return send(res, err.status ?? 400, { error: err.message }, cors);
    }
    const problem = validateMessages(body?.messages, cfg);
    if (problem) return send(res, 400, { error: problem }, cors);

    try {
      const result = await runChatTurn({
        core,
        messages: body.messages,
        details: body.details,
        apiKey: cfg.apiKey,
        model: cfg.model,
        maxTokens: cfg.maxTokens,
        maxToolRounds: cfg.maxToolRounds,
        fetchImpl,
      });
      return send(res, 200, result, cors);
    } catch (err) {
      const status = err instanceof AgentError ? err.status : 500;
      // Log the cause for us; never send it to the visitor.
      log.error(`[chat] ${err.message}${err.cause ? `: ${err.cause.message}` : ''}`);
      return send(res, status, { error: 'Sorry, the assistant could not answer just now. Please try again, or use the form.' }, cors);
    }
  }

  return http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://x');
      const origin = req.headers.origin;
      const cors = corsHeaders(origin, cfg);

      if (pathname === '/healthz') return send(res, 200, { ok: true });

      if (pathname === '/api/chat') {
        if (origin && !cors['access-control-allow-origin'] && !isSameOrigin(req, origin)) {
          return send(res, 403, { error: 'Origin not allowed' });
        }
        if (req.method === 'OPTIONS') return send(res, 204, '', cors);
        if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' }, { ...cors, allow: 'POST, OPTIONS' });
        return await handleChat(req, res, cors);
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
      return await serveStatic(req, res);
    } catch (err) {
      log.error(`[server] ${err.stack ?? err}`);
      if (!res.headersSent) send(res, 500, { error: 'Server error' });
    }
  });
}

// Start when run directly (npm start), not when imported by tests.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const cfg = readConfig();
  if (!cfg.apiKey) console.warn('ANTHROPIC_API_KEY is not set: the page will load but the chat will be off.');
  createServer(cfg).listen(cfg.port, () => {
    console.log(`Heat pump agent listening on :${cfg.port} (model ${cfg.model})`);
  });
}

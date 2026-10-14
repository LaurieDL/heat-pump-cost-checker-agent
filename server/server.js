// Heat pump cost checker agent: serves the page and POST /api/chat.
// Express app; configure with environment variables (see .env.example).
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import { loadCore } from '../core/load-core.js';
import { runChatTurn, AgentError } from './agent.js';
import { createRateLimiter } from './rate-limit.js';
import { compress } from './compress.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const SHARED_DIR = path.join(ROOT, 'shared');
const CORE_FILE = path.join(ROOT, 'core', 'heat-pump-core.js');
const MAX_BODY = '64kb';
const ASSET_CACHE = 'public, max-age=300';

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': [
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
  const port = int(env.PORT, 3000);
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  // In a GitHub Codespace, allow the forwarded address of this port automatically.
  if (env.CODESPACE_NAME && env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN) {
    allowedOrigins.push(`https://${env.CODESPACE_NAME}-${port}.${env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`);
  }
  return {
    port,
    apiKey: env.ANTHROPIC_API_KEY ?? '',
    model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
    allowedOrigins,
    trustProxy: env.TRUST_PROXY !== 'false',
    ratePerHour: int(env.RATE_LIMIT_PER_HOUR, 40),
    globalPerDay: int(env.GLOBAL_LIMIT_PER_DAY, 3000),
    maxMessageChars: int(env.MAX_MESSAGE_CHARS, 1200),
    maxTurns: int(env.MAX_TURNS, 30),
    maxToolRounds: int(env.MAX_TOOL_ROUNDS, 5),
    maxTokens: int(env.MAX_OUTPUT_TOKENS, 1024),
  };
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

// ── Middleware ───────────────────────────────────────────────

function securityHeaders(req, res, next) {
  res.set(SECURITY_HEADERS);
  next();
}

/** CORS for /api/chat: the allow-listed sites, plus the service's own page. Everyone else gets 403. */
function cors(cfg) {
  return (req, res, next) => {
    const origin = req.get('origin');
    if (!origin) return next(); // same-origin GETs and server-to-server calls carry no Origin
    if (cfg.allowedOrigins.includes(origin)) {
      res.set({
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      });
      return next();
    }
    let sameOrigin = false;
    try { sameOrigin = new URL(origin).host === req.get('host'); } catch { /* malformed Origin */ }
    if (sameOrigin) return next();
    return res.status(403).json({ error: 'Origin not allowed' });
  };
}

function rateLimit(limiter, keyFn, onLimited) {
  return (req, res, next) => {
    const { allowed, retryAfterSeconds } = limiter.take(keyFn(req));
    if (allowed) return next();
    return onLimited(req, res, retryAfterSeconds);
  };
}

// ── App ──────────────────────────────────────────────────────

export function createApp(cfg = readConfig(), { core = loadCore(), fetchImpl = fetch, now = () => Date.now(), log = console } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // Railway's edge proxy appends the real client address to X-Forwarded-For; trusting one hop
  // makes req.ip that address. Earlier entries in the header can be spoofed and are ignored.
  app.set('trust proxy', cfg.trustProxy ? 1 : false);
  app.use(securityHeaders);

  app.get('/healthz', (req, res) => res.set('Cache-Control', 'no-store').json({ ok: true }));

  // ── Chat API ──
  const perIp = createRateLimiter({ limit: cfg.ratePerHour, windowMs: 60 * 60 * 1000, now });
  const daily = createRateLimiter({ limit: cfg.globalPerDay, windowMs: 24 * 60 * 60 * 1000, now });
  const api = express.Router();
  api.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }, cors(cfg));
  api.options('/chat', (req, res) => res.sendStatus(204));
  api.post(
    '/chat',
    (req, res, next) => (cfg.apiKey ? next() : res.status(503).json({ error: 'The assistant is not configured yet.' })),
    rateLimit(perIp, (req) => req.ip ?? 'unknown', (req, res, retryAfter) => res
      .set('Retry-After', String(retryAfter))
      .status(429)
      .json({ error: "You've sent a lot of messages. Please try again later, or use the form." })),
    rateLimit(daily, () => 'all', (req, res) => res
      .status(503)
      .json({ error: 'The assistant is busy today. Please use the form for now.' })),
    // Parse every body as JSON, whatever its content type, so oversized or malformed bodies are refused here.
    express.json({ limit: MAX_BODY, type: () => true }),
    async (req, res) => {
      const problem = validateMessages(req.body?.messages, cfg);
      if (problem) return res.status(400).json({ error: problem });
      try {
        const result = await runChatTurn({
          core,
          messages: req.body.messages,
          details: req.body.details,
          asked: req.body.asked,
          apiKey: cfg.apiKey,
          model: cfg.model,
          maxTokens: cfg.maxTokens,
          maxToolRounds: cfg.maxToolRounds,
          fetchImpl,
        });
        return res.json(result);
      } catch (err) {
        const status = err instanceof AgentError ? err.status : 500;
        // Log the cause for us; never send it to the visitor.
        log.error(`[chat] ${err.message}${err.cause ? `: ${err.cause.message}` : ''}`);
        return res.status(status).json({ error: 'Sorry, the assistant could not answer just now. Please try again, or use the form.' });
      }
    },
  );
  api.all('/chat', (req, res) => res.set('Allow', 'POST, OPTIONS').status(405).json({ error: 'Use POST' }));
  app.use('/api', api);

  // ── Static files: only these three places are ever served ──
  // The page itself is always re-checked (no-cache, answered with a cheap 304 when unchanged) so a
  // deploy shows up at once. Scripts, styles and the core may be reused for a few minutes without
  // asking again, which makes repeat visits instant. Keep it short: the page's scripts load each
  // other, so a long lifetime could mix old and new files after a deploy.
  const cacheControl = (res, filePath) => res.set('Cache-Control', /\.html$/.test(filePath) ? 'no-cache' : ASSET_CACHE);
  const staticOpts = { index: 'index.html', dotfiles: 'ignore', fallthrough: true, setHeaders: cacheControl };
  app.use(compress());
  app.get('/core/heat-pump-core.js', (req, res) => res.set('Cache-Control', ASSET_CACHE).type('js').sendFile(CORE_FILE));
  app.use('/shared', express.static(SHARED_DIR, { ...staticOpts, index: false }));
  app.use(express.static(PUBLIC_DIR, staticOpts));

  app.use((req, res) => res.status(404).type('text').send('Not found'));

  // Express 5 sends errors from body parsing and async handlers here.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) log.error(`[server] ${err.stack ?? err}`);
    const message = status === 413 ? 'Request too large' : status === 400 ? 'Invalid JSON' : 'Server error';
    if (res.headersSent) return;
    res.status(status).json({ error: message });
  });

  return app;
}

/** An http.Server wrapping the app (what tests and `npm start` use). */
export function createServer(cfg = readConfig(), opts = {}) {
  return http.createServer(createApp(cfg, opts));
}

// Start when run directly (npm start), not when imported by tests.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const cfg = readConfig();
  if (!cfg.apiKey) console.warn('ANTHROPIC_API_KEY is not set: the page will load but the chat will be off.');
  createServer(cfg).listen(cfg.port, () => {
    console.log(`Heat pump agent listening on :${cfg.port} (model ${cfg.model})`);
    if (cfg.allowedOrigins.length) console.log(`Other sites allowed to call /api/chat: ${cfg.allowedOrigins.join(', ')}`);
  });
}

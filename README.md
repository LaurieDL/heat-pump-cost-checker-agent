# heat-pump-cost-checker-agent

An AI assistant version of the [fidesq.com heat pump cost calculator](https://fidesq.com/heat-pump-cost-calculator.html).
Visitors describe their home in plain English; the assistant fills in the details, runs the
site's own estimate and explains the result. The original form stays on the page and gives
the same answer without the AI.

## How it works

```
browser                                   this service (Railway)                 Anthropic
───────                                   ──────────────────────                 ─────────
chat + "Your home" form  ── POST /api/chat ─▶ agent loop (server/agent.js) ──────▶ Claude
estimate cards           ◀── reply, details ─  tools (shared/agent-tools.js)
  ▲                                              │
  └── HeatPumpCore.estimate() ◀──────────────────┘  core/heat-pump-core.js
```

- **Claude never does the maths.** Its tools record the visitor's details and call
  `HeatPumpCore.estimate()`, the same generated core fidesq.com uses
  (`/assets/js/heat-pump-core.js`). Every figure on the page is computed by that code,
  with its source and the date it was checked.
- **The API key stays on the server.** The page only ever calls `/api/chat`.
- **Stateless.** The page sends the chat history and the current details on each turn,
  so the service can be restarted or scaled without losing conversations.

| Path | What it is |
|---|---|
| `core/heat-pump-core.js` | Byte-for-byte copy of fidesq.com's calculation core. Don't edit; copy a new version over it. |
| `shared/agent-tools.js` | The three tools (`update_home_details`, `estimate_heat_pump`, `compare_scenario`) and input checking. Runs in the browser and in Node. |
| `shared/prompt.js` | The assistant's instructions and background facts. |
| `shared/place.js` | Postcode area → nation, ported from the site. Only the first half of a postcode is kept. |
| `server/` | Express server: static files, `/api/chat`, rate limits, CORS, security headers. Express is the only dependency. Static files are compressed (brotli/gzip, built-in `zlib`) and cached for 5 minutes; the page itself is always re-checked. |
| `public/` | The page. `transport.js` is the only part that knows where the agent runs. |
| `prototype/`, `scripts/build-prototype.mjs` | Builds a one-file version that runs inside claude.ai for demos. |

## Run it locally

Needs Node 20 or later.

```bash
npm ci                      # installs Express, the only dependency
cp .env.example .env        # then add ANTHROPIC_API_KEY
npm run dev                 # http://localhost:3000
npm test
```

### In a GitHub Codespace

Code → Codespaces → Create codespace. The server starts on its own and port 3000 opens in
the browser. Codespaces asks for `ANTHROPIC_API_KEY` as a secret the first time (or add it
under GitHub Settings → Codespaces → Secrets); you can also put it in `.env`. The Codespace's
own address is allowed automatically. Keep the port's visibility Private, or anyone with the
link can spend credit on your key.

## Deploy on Railway

1. **New service** in the Fidesq project → *Deploy from GitHub repo* → this repo.
   Railway detects Node, installs from `package-lock.json` and runs `npm start`. No build step.
2. **Variables**:
   - `ANTHROPIC_API_KEY`: a key from Fidesq's Anthropic account, made just for this service.
     Set a monthly spend limit on its workspace in the Anthropic Console.
   - `ALLOWED_ORIGINS=https://fidesq.com,https://www.fidesq.com`
   - Optional: `ANTHROPIC_MODEL`, and the limits in `.env.example`.
3. **Health check**: set the path to `/healthz`.
4. Open the `*.up.railway.app` address and try it.
5. Optional: add a custom domain such as `api.fidesq.com`.

Keep the service at **one replica**: the rate limiter is in memory. Moving it to Redis is the
change to make before scaling out.

## Putting it on fidesq.com

The page can be served from this service as is, or the calculator section can move into
fidesq.com's `heat-pump-cost-calculator.html`. For the second, copy the markup between the
`page:body` markers, load `styles.css`, `render.js`, `app.js`, `transport.js` and
`/shared/*.js`, and set:

```html
<meta name="hp-api-base" content="https://api.fidesq.com">
```

The privacy wording on the site must change at the same time: chat messages go to Anthropic,
so "it never leaves your browser" is only true of the form.

## Safety and cost controls

- Per-visitor limit (`RATE_LIMIT_PER_HOUR`, default 40) and a daily cap across everyone
  (`GLOBAL_LIMIT_PER_DAY`, default 3,000). The Anthropic spend limit is the final backstop.
- Message length, conversation length, tool rounds and reply length are all capped.
- Visitor details are checked against fixed lists before they reach the core or the prompt.
- The tools only read the vendored figures: no web access, email or database writes, so a
  prompt-injection attempt has nothing to act on.
- Errors from Anthropic are logged on the server and never shown to visitors.

## Updating the figures

When fidesq.com's core changes (for example a new Ofgem price cap), copy the new
`/assets/js/heat-pump-core.js` over `core/heat-pump-core.js` and run `npm test`. The tests
check the core still matches the figures quoted on the site, so update them if those change.

## Improving the assistant

`docs/quality-phases.md` is a five-phase plan (evals, figure checks, better extraction, smarter
questions, reliability and feedback). Each phase is one pull request and can be built by telling
Claude: "Read `docs/quality-phases.md`, then build Phase 1."

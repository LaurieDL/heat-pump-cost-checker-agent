# Content import and stack refactor: prompt for Claude

Two jobs, done in order:

1. **Phase 1: content import.** Bring all of the content from the fidesq.com heat pump calculator page into this repo.
2. **Phase 2: stack refactor.** Move to Next.js, Tailwind CSS, Express/Node, Jest, Vite and anything else worth adding, after a written plan is approved.

**How to use it.** Start a Claude session that can reach this repo, attach the markdown of
https://fidesq.com/heat-pump-cost-calculator.html, and paste everything below the line, or say:
"Read `docs/content-import-and-stack-refactor.md` and follow it." Claude starts with section 3
(orient), then Phase 1, and only starts Phase 2 once Phase 1 is merged and you agree.

**Related plans in this folder**
- `quality-phases.md`: five pull requests that make the assistant's answers more accurate and reliable (evals, figure checks, better extraction, smarter questions, retries and feedback).
- `live-knowledge.md`: how to keep the data and background text fresh, and where the numbers come from.

The stack refactor moves files around, so the file paths in those two plans would change.
Claude is asked below to recommend an order; the usual advice is Phase 1, then the quality
phases (the eval gives the refactor a safety net), then Phase 2.

---

# Fidesq heat pump cost checker: brief for Claude

## 1. Who you are and how you work
You are a senior full-stack engineer and technical adviser helping me, Laurie, develop an AI heat pump cost checker for my business, Fidesq. I am not a developer, so explain in plain English: lead with the answer, keep it short, and explain any jargon in a few words.

Work like a senior colleague, not a code generator:
- Read before you suggest. Never assume how the code works; open the file.
- Find the cause, not just the symptom. Where there is a quick fix and a proper fix, name both and say which you'd choose.
- If my question rests on a wrong assumption, say so before answering. If something is a bad idea, say so.
- Choose the simplest thing that works. Don't over-engineer and don't under-build. Where there are real options, give two or three with the trade-offs, then recommend one.
- Never invent library behaviour, settings or APIs. If you're unsure, check the official docs or say "I'd need to check". State versions when they matter.
- Write complete, working code with tests. No placeholders.
- Think about security without being asked: secrets, injection, CORS, rate limits, what gets logged.
- Don't add npm packages the existing stack can handle. Express is the only dependency today. Any new one needs a one-line reason and my OK.
- Never say something works unless you have run it. Say exactly what you ran and what you couldn't run.

## 2. Hard rules
1. Never edit core/heat-pump-core.js. It is generated (its first line says so) from the heat-pump-plugin project and is a byte-for-byte copy of the calculator on fidesq.com.
2. Every figure about a visitor's home comes from that core. The AI never calculates, rounds or invents figures.
3. Never commit API keys or .env. The Anthropic key stays on the server.
4. Never push to main. One branch and one pull request per step; I review and merge.
5. Run the tests (node --test) before every pull request. All must pass, and the test count only goes up.
6. Never log or store visitors' message text, postcodes or addresses.
7. Ask me before any decision that changes cost, hosting, privacy or how the page looks. Don't guess.
8. If you can't reach something (a website, the repo, a tool), say so plainly and tell me what to attach or do. Don't work around it or invent content.

## 3. Start here: connect and orient
Work in https://github.com/LaurieDL/heat-pump-cost-checker-agent. Clone it. Read README.md, package.json, everything in docs/ (quality-phases.md and live-knowledge.md are planning documents) and every file under core/, shared/, server/, public/, prototype/ and test/. Run npm ci and npm test. Then tell me briefly:
- what is merged and what is still open (git log, open pull requests)
- how many tests there are and whether they pass
- anything in the docs that no longer matches the code
- the order you recommend for the work below, and why

What is there now:
* A chat assistant that turns a plain-English description of a home into a heat pump estimate. Its tools (update_home_details, estimate_heat_pump, compare_scenario, ask_visitor) record details and ask for any that are missing, one at a time.
* Where the figures come from: heat-pump-plugin source, built by scripts/build-heat-pump-core.sh into /assets/js/heat-pump-core.js on fidesq.com, copied here as core/heat-pump-core.js. The figures are static; they change only when that chain is rebuilt.
* An Express server (POST /api/chat) that holds the Anthropic API key, with rate limits, CORS, a CSP and input checks.
* A plain HTML/CSS/JS page with the chat, an editable "Your home" form and the result cards.
* Tests run with node --test; a .devcontainer for GitHub Codespaces; deployed on Railway from main.

## 4. Explain how I keep developing this
Briefly, in plain English:
* How I ask you for changes (for example: "Read docs/quality-phases.md and build Phase 1"), and how branches and pull requests keep main safe.
* How to test a change before it goes live: Codespaces, and Railway preview deploys if they're worth setting up.
* How changes reach the live site: merging to main triggers a Railway deploy.
* What I must never do: commit API keys or .env, push straight to main, or edit core/heat-pump-core.js by hand.
* How to update the figures when the calculator changes, for example a new Ofgem price cap: change the heat-pump-plugin source, run its build script, publish the new file on fidesq.com, copy it over core/heat-pump-core.js here, run the tests (they check the figures against the site), and update the "checked" dates. If you don't know where the plugin lives, ask me.

## 5. Phase 1: bring over all the page content
The attached markdown is the full content of https://fidesq.com/heat-pump-cost-calculator.html. If you can, also fetch the live page and tell me about anything the markdown is missing.

1. Make a table of every section, table, figure, source link and "checked" date on the page, marking each present, partly present or missing in the repo and where it lives. Show me that table and wait for my OK before changing anything.
2. Add everything missing, keeping wording, figures, sources and dates exactly as on fidesq.com:
   - the cost-by-size table and VAT note
   - the "Against a new boiler" section
   - the grant section: who qualifies, how you get it, Scotland and Northern Ireland
   - the running costs table and "How we worked it out"
   - what changes the price
   - the survey
   - choosing an MCS certified installer
   - the FAQ, with the same FAQPage JSON-LD the site uses
   - the "Book a 20-minute call" section
   - page title, meta description and Open Graph tags
3. Keep every number in one place. Use figures from core/heat-pump-core.js wherever the core has them. Figures it doesn't have (for example DESNZ statistics or grant deadlines) go in a single content module, each with its source and checked date, and the assistant's background text (GUIDE in shared/prompt.js) must use the same values. No figure is typed twice.
4. Generate the FAQ JSON-LD from the same data that renders the visible FAQ, so the two can never differ.
5. Fix one known error. For Scotland the grant card says "Or £9,000 if your home has no mains gas", but in Scotland the extra £1,500 is for rural and island homes. Fix it here, and tell me the live site has the same mistake (it must be fixed in the plugin source).
6. The page says nothing leaves the browser, but chat messages are sent to Anthropic. Make that wording accurate everywhere it appears.
7. Quality bar: it looks like fidesq.com, works on a phone (check 375px and 1280px wide), has no console errors, and is accessible (heading order, link text, contrast, keyboard use).
8. Add tests: every figure in the content matches the core, and the JSON-LD is valid and matches the FAQ.
9. Do all of this on a new branch, run the tests and open one pull request that lists what you added and anything you left out on purpose. If it would be too big to review, propose a split and ask me first.

## 6. Phase 2: refactor the stack
After Phase 1 is merged, and after telling me whether to finish the quality phases in docs/quality-phases.md first (an eval harness gives the refactor a safety net), refactor to: Next.js, Tailwind CSS, Express/Node, Jest for testing, Vite, plus anything else useful.

Before writing any code, write me a short plan and wait for my go-ahead. It must cover:
* Vite and Next.js: Next.js already has its own build tool, so explain whether Vite adds anything. If it doesn't, recommend leaving it out, or using Vitest in place of Jest if that's simpler.
* Express and Next.js: compare (a) Next.js API routes with no Express, (b) Express wrapping Next.js as a custom server on one Railway service, and (c) a separate Express API service and Next.js front end. Cover hosting cost, complexity, how each deploys on Railway, the one-replica limit of the in-memory rate limiter, and whether server-rendered pages help the page's SEO. Recommend one.
* Anything else worth adding, each with a one-line reason: TypeScript, ESLint and Prettier, schema validation (for example Zod), Playwright browser tests, GitHub Actions running the tests on every pull request (it may need extra permission on the repo).
* How you will prove nothing changed: tests ported first, the same /api/chat contract, screenshot comparison of key states, and the eval if it exists. Also the rollout (a Railway preview first) and how to roll back.

Rules for the refactor:
* The page must look and behave the same: fidesq.com's design, the chat, the form, the cards and the question loop.
* Keep core/heat-pump-core.js unchanged and still the only source of figures.
* Keep the API key server-side only, and keep the rate limits, CORS, CSP and input checks.
* Port every existing test to the new test runner before changing behaviour. All tests must pass.
* It must still deploy on Railway from main with only these variables: ANTHROPIC_API_KEY, ALLOWED_ORIGINS, and optionally ANTHROPIC_MODEL. Update the README and .devcontainer.
* Work in small steps, one branch and one pull request per step.

## 7. How to report
Before each step, say in a sentence what you're about to do. After it, tell me:
* what changed, in two or three sentences
* how to check it: three concrete things to look at
* what could go wrong
* what comes next, and anything I need to decide

Ask me whenever a decision is mine to make. Don't guess on anything that changes cost, hosting, privacy or how the page looks.

# Making the assistant's knowledge dynamic and live

A plan to come back to. It explains what the assistant knows today, where that knowledge goes
stale, and a practical, staged way to keep it fresh, with the technical work for each stage.

Each stage (K1 to K5) is one pull request and can be built by telling Claude, in a session
connected to this repo: "Read `docs/live-knowledge.md`, then build step K1." These steps are
separate from the quality phases in `docs/quality-phases.md` (called Phase 1 to 5 there); where
the two touch, the notes below say so.

## The idea in one paragraph

Most of what this app relies on changes on known dates (the Ofgem price cap each quarter, grant
rules, the VAT cutoff, monthly install-cost statistics), and a wrong figure is advice someone
acts on. So the aim is **knowledge that is dated, checked by machines and approved by a person**,
not knowledge that rewrites itself. Fully live lookups are used only where the answer genuinely
varies per visitor or per day (a postcode that straddles a border, a current tariff).

## 1. What the assistant knows today

| Where | What it holds | How it is updated |
|---|---|---|
| `core/heat-pump-core.js` | All figures for a visitor's home: install costs, grant rules, energy prices, assumptions, dated source links (`sources`, each with a `checked` date) and facts with a `valid_to` date | Copied by hand from fidesq.com's `/assets/js/heat-pump-core.js`. Never edited here. |
| `GUIDE` in `shared/prompt.js` (lines 5 to 18) | Background prose for general questions: grant rules, who qualifies, Scotland and Northern Ireland, VAT, running-cost rules of thumb, choosing an installer. Starts "figures checked 5 October 2026". | Edited by hand |
| `QUESTIONS` in `shared/agent-tools.js` | Question hints and fallback wording, including £7,500 and £9,000 | Edited by hand |
| `public/index.html` line 75 | The visible "Prices checked 5 October 2026" | Edited by hand |

### Problems this plan fixes
1. **Two copies of the truth.** `GUIDE`, `QUESTIONS` and the page text repeat figures that the core also holds. A change in one doesn't change the others, and nothing notices.
2. **Nothing alerts anyone when a fact expires.** The core knows when a fact passes its `valid_to` date and the page can show a warning, but no one is told in advance, and the hand-written copies have no dates at all.
3. **The vendored core can fall behind the live site silently.**
4. **The "checked" date on the page is typed in by hand**, so it can be wrong.
5. **The prose can only grow inside the system prompt.** That works up to a point (see K5).

## 2. Sources: what exists and how you get at it

Checked on 14 October 2026 unless it says "not checked". Anything marked "confirm" must be
verified by whoever builds the step before relying on it.

| Knowledge | Source | Access | Cadence | Status |
|---|---|---|---|---|
| Grant amounts, eligibility, deadlines | GOV.UK pages (for example `/apply-boiler-upgrade-scheme/what-you-can-get`) | **GOV.UK Content API**: `GET https://www.gov.uk/api/content/<page path>` returns the page as JSON. No authentication, open to anyone, 10 requests per second per client, Open Government Licence v3.0. Documented as beta, so it may change. | When policy changes | Verified from its docs page. Confirm the exact field names (`public_updated_at`, `details`) from the reference docs. |
| Energy price cap unit rates and standing charges | Ofgem web pages and PDFs/spreadsheets | No live API found in searching. Published as pages and downloadable files, quarterly (1 Jan, 1 Apr, 1 Jul, 1 Oct), announced roughly five weeks ahead. | Quarterly | Confirm whether Ofgem offers a data feed before writing a scraper. |
| Install costs from real grant-funded installs | DESNZ "Boiler Upgrade Scheme statistics" releases on GOV.UK | Statistical release pages with downloadable data files. The Content API can detect a new release; the data is read from the file. | Monthly | Not checked in detail |
| Oil and LPG prices | Nottingham Energy Partnership guide | Web page. No API known. | Monthly | Not checked |
| Heat pump electricity tariffs | Octopus Energy REST API | `GET https://api.octopus.energy/v1/products` and `.../products/{product_code}/electricity-tariffs/{tariff_code}/standard-unit-rates/` work **without authentication** according to Octopus's docs. Rate limits and terms of use are not stated there. | Changes with the tariff | Confirm: how a tariff code encodes the region, rate limits, and whether Octopus's terms allow use in a public website. |
| Postcode area to nation | postcodes.io | Free public API. Code is MIT licensed; Great Britain data under the OS OpenData licence; **Northern Ireland (BT) postcode data needs a licence for commercial use**. Rate limits and fair use are not stated on the about page. | Static | Confirm the outward-code ("outcode") endpoint and its response before using it. |
| Property facts (EPC rating, floor area, wall type) | The government's EPC data service | Needs registration and a lookup by address. | n/a | Not checked. Address lookups are a privacy question; see section 6. |

## 3. Target design

```
 sources (GOV.UK, Ofgem, DESNZ, ...)
        │  weekly check (K3)                  fidesq.com core  ── core:check (K2) ──┐
        ▼                                                                           │
  refresh report ─▶ human approves ─▶ PR ─▶ knowledge/facts.json  +  core/*.js     │
                                                 │                                  │
                          tests fail if a fact is overdue or disagrees with the core ◀┘
                                                 │
                       shared/prompt.js builds GUIDE from the facts  ─▶  system prompt
                       page reads its "checked on" date from the core
        live tools (K4): postcode outcode, tariffs ── cached, timed out, always with a fallback
```

Principles:
- **One place for each fact**, with its source, the date it was checked and the date it stops being valid.
- **Machines notice, people approve.** Nothing changes the figures a visitor sees without a reviewed PR.
- **Every live call can fail.** Each has a timeout, a cache and a fallback to the last good value, so the chat never breaks because a third party did.
- **The model still never does arithmetic.** Live data reaches the model only as tool results, and the figure guard (quality Phase 2) accepts figures from tool results.

## 4. The steps

### K1. Facts as data, with freshness checks
Branch: `knowledge/k1-facts-as-data`

**What and why.** Move the facts out of prose into one reviewable file, build `GUIDE` from it, and add tests that fail when something is out of date. This removes problems 1, 2 and 4 with no new infrastructure.

**Technical work**
1. Create `knowledge/facts.json`: an array of entries.
   ```json
   {
     "id": "grant.bus.standard",
     "value": 7500, "unit": "GBP",
     "text": "£7,500 off",
     "source": { "label": "Grant amounts and rules (GOV.UK)", "url": "https://www.gov.uk/apply-boiler-upgrade-scheme/what-you-can-get" },
     "checkedOn": "2026-10-05",
     "validUntil": null,
     "reviewBy": "2027-01-05",
     "coreCheck": "grant.amount.standard"
   }
   ```
   `coreCheck` names the place in the core's output this fact must agree with, when there is one.
2. Create `knowledge/guide.md`: today's `GUIDE` text with `{{fact:id}}` placeholders where a figure or date appears (for example "Grant (England and Wales): {{fact:grant.bus.standard}}").
3. New `shared/knowledge.js` (browser-safe, no Node-only APIs; add it to `MODULES` in `scripts/build-prototype.mjs` before `shared/prompt.js`). Because the prototype bundler drops `import` lines and can't read files, `facts.json` and `guide.md` are turned into a generated module `shared/knowledge-data.js` by a small script, `npm run knowledge:build`, which is committed. Tests fail if the generated file is out of date with its inputs.
   - `renderGuide(facts, template)` replaces every placeholder; it throws on an unknown id or on a fact never used.
   - `staleFacts(facts, today)` returns facts past `validUntil` or `reviewBy`.
   - `checkAgainstCore(facts, core, today)` runs `core.estimate` for a few reference homes and compares each `coreCheck` value; returns mismatches.
4. `shared/prompt.js`: `GUIDE` becomes `renderGuide(...)`. The header line "figures checked <date>" is the latest `checkedOn` among the facts.
5. Do the same for the repeated figures in `QUESTIONS` (use the facts, not literals).
6. `public/index.html` line 75: replace the typed date with a placeholder filled at page load from the core (`pricesCheckedOn` from an estimate of a sample home, or the newest `sources[*].checked`). No hard-coded date remains.
7. Server start-up logs a warning for each stale fact. `npm run knowledge:check` prints the same list and exits non-zero if any fact is overdue.

**Tests**
- Every placeholder resolves; an unused fact fails; an unknown placeholder fails.
- `renderGuide` output equals the current `GUIDE` text exactly (a golden test taken before the change, so the move changes no wording).
- Stale detection with a fixed `today`. A mismatch with the core is caught (feed it a core stub with a different amount).
- The generated module matches its inputs.
- The page's date comes from the core (unit-test the pure function that picks it).

**Done when:** the assistant's answers are unchanged, `npm test` passes, no figure in `GUIDE` or `QUESTIONS` is typed twice, and the page's date is not typed by hand.

**Link to quality phases.** Phase 2's figure guard builds its allowed set from `GUIDE` and `QUESTIONS` text; it keeps working because both are now generated from the facts.

### K2. Detect core drift
Branch: `knowledge/k2-core-sync`

**What and why.** The core is a vendored copy of the live site's file. This step shows when they differ (problem 3).

**Technical work**
1. `scripts/core-check.mjs`, run as `npm run core:check`: fetch `https://fidesq.com/assets/js/heat-pump-core.js`, compare its SHA-256 with `core/heat-pump-core.js`, and print "in sync" or "out of sync: live is newer/different" with both hashes and file sizes. Exit 1 when out of sync. A `--update` flag writes the live file over the vendored one (the person then reviews the diff and runs the tests).
2. Record the vendored file's hash and the date it was copied in `core/SOURCE.md`. `--update` rewrites it.
3. The script needs outbound HTTPS to fidesq.com. It runs in a Codespace or on Railway; it may not run in Claude's cloud sandbox, where the shell can only reach package registries. Say so in the script's error message rather than failing silently.
4. A test with a fake `fetch` covers in sync, out of sync and network failure.

**Done when:** one command tells you whether the repo's core is the site's core.

### K3. Watch the sources, propose the changes
Branch: `knowledge/k3-source-watcher`

**What and why.** Notice when a source page changes, so a person finds out within days, not months.

**Technical work**
1. Add a `watch` block to facts that come from GOV.UK:
   ```json
   "watch": { "type": "govuk-content", "path": "apply-boiler-upgrade-scheme/what-you-can-get",
              "mustContain": ["£7,500"], "hash": "…", "lastSeenUpdatedAt": "2026-09-30T…" }
   ```
2. `scripts/knowledge-watch.mjs` (`npm run knowledge:watch`): for each watched fact, fetch `https://www.gov.uk/api/content/<path>` (rate limit 10 requests a second; use one at a time with a short pause), read the page's last-updated field (confirm its name in the Content API reference), hash the body text, and check each `mustContain` string is still present. Print a Markdown report: unchanged, changed (with the new last-updated date and a link), and broken (a required string vanished, which usually means a rule changed).
3. For sources without an API (Ofgem, DESNZ, Nottingham Energy Partnership), list them in the report under "check by hand" with the date they were last checked and when the next release is due (Ofgem: announced about five weeks before 1 Jan, 1 Apr, 1 Jul and 1 Oct). Do **not** scrape them in this step; first confirm whether a feed exists.
4. Run it weekly. Three options, in order of preference:
   - **A scheduled Claude task** that runs `npm run knowledge:watch`, and if something changed, reads the changed pages, drafts the edits to `knowledge/facts.json`, and opens a PR describing each change with its source link. A person reviews and merges. This keeps a human in the loop and costs nothing when nothing changed.
   - **Railway cron** running the script and writing the report to the logs, with a person doing the edits.
   - **GitHub Actions** on a weekly schedule opening an issue. This needs workflow permission on the repo, which the current GitHub access may not have.
5. The script only reads. It never edits `facts.json` itself and never touches the core.

**Tests:** fake `fetch` for changed, unchanged, missing string, network failure, and HTTP errors; the report text for each; the 10 requests per second limit is respected.

**Done when:** a changed GOV.UK page produces a report entry within a week, and the PR checklist in the next section exists.

### K4. Live tools, only where they earn their place
Branch: `knowledge/k4-live-lookups` (can be split into two PRs)

Build this after the quality plan's Phase 2 (figure guard) and Phase 3 (strict tool schemas), so live data passes through the same checks.

Rules for every live lookup: a hard timeout (2 to 3 seconds), an in-memory cache with a time to live, a fallback to the last good value or to no answer, a log line (status only, no visitor data), and a user-visible label such as "Live from Octopus Energy, fetched at 10:42".

**K4a. Border postcodes.** The page keeps only the outward half of a postcode (for example `CH5`) and maps it to a nation with the table in `shared/place.js`. A few outward codes straddle England and Wales or England and Scotland (for example CH, SY, HR, NP and TD; confirm the full list from the lookup itself), and the nation sets which grant applies.
1. Add `lookupOutcode(outcode)`, calling postcodes.io's outward-code lookup (confirm the endpoint and response). If it returns more than one country, the assistant asks the visitor which side they are on, using `ask_visitor`, instead of guessing.
2. Send **only the outward code**, never the full postcode. List postcodes.io in the privacy wording as a service that receives it.
3. Skip the lookup entirely for BT postcodes (always Northern Ireland; avoids the commercial-licence question for that data).
4. Cache each outcode for a day. Fall back to the existing table.
5. Honest assessment: the value here is small unless border mistakes turn out to be common. Do this only if the eval or real feedback shows nation errors.

**K4b. Heat pump tariffs.** The core costs electricity at the Ofgem price cap, so it can't show what a heat pump tariff would do. Two ways:
1. **Preferred:** ask Laurie to add an optional electricity-rate input to the site's core, so the core stays the only calculator. The tool fetches a current heat pump tariff's unit rate from the Octopus API (a region lookup is needed; confirm how), passes it into `core.estimate`, and returns the result as a what-if next to the standard one.
2. **Not recommended:** a separate calculation in this repo. It would have its own method and could disagree with the core.
Before building: confirm Octopus's terms for public website use and their rate limits; a heat pump tariff is a specific product code that Octopus will retire, so the tool must handle a missing product gracefully and say the tariff is a worked example, not a recommendation.

**Tests:** fake `fetch` for success, timeout, malformed JSON, multi-country outcode; cache hit and expiry; fallback path; the tool result is accepted by the figure guard and the label is included.

### K5. Search the guide when it outgrows the prompt
Branch: `knowledge/k5-guide-search`

**When to build it.** Only when the guide plus any imported site content is bigger than roughly 6,000 words, or the eval shows the assistant missing facts that are in the guide. Below that, a prompt-cached system prompt is simpler and more reliable than search.

**Technical work**
1. Split the guide into `knowledge/guide/*.md` sections, each with front matter: `id`, `title`, `updated`, `sources`, `tags`. K1's `{{fact:id}}` placeholders still apply.
2. `search_guide` tool: takes `{ query }`, scores sections by keyword overlap with title, tags and text (a small pure function, no dependency), returns the top three with `{ id, title, updated, source, text }`.
3. The system prompt keeps a one-line contents list, tells the model to call `search_guide` for anything beyond the saved details and the always-included core facts, and to say so when nothing matches.
4. Move to embeddings only if keyword search measurably fails on the eval; that would be a decision with a cost and a new dependency, so it needs Laurie's agreement.

**Tests:** ranking on a fixed set of queries (grant, VAT, tenant, Scotland loan, survey); empty and nonsense queries; results include source and date; the figure guard accepts figures from results.

## 5. The routine once this exists

| When | Who | What |
|---|---|---|
| Weekly | Scheduled task or Roland | `npm run knowledge:watch`; read the report |
| About five weeks before 1 Jan, 1 Apr, 1 Jul, 1 Oct | Laurie or Roland | New Ofgem price cap: update the site's core, then `npm run core:check -- --update`, `npm run knowledge:check`, run the eval, merge |
| Monthly | Laurie or Roland | New DESNZ statistics: update install-cost figures in the core |
| Before 31 March 2027 | Laurie | The £9,000 oil/LPG grant window and 0% VAT both end. Set `validUntil` on those facts now so tests flag them in good time. From 1 April 2027 VAT is 5%. |
| Any time | CI or a person | `npm test` fails if a fact is overdue |

**PR checklist for any knowledge change:** source link in the description; `checkedOn` dates updated; core copied from fidesq.com if its figures moved; `npm run knowledge:check` clean; `npm test` and the eval pass; page date correct; privacy wording still true.

## 6. Risks and decisions for Laurie

- **Approval stays human.** Grant rules and prices are advice. Auto-publishing unreviewed changes would remove the "checked on" trust the page builds. K3 proposes; a person decides.
- **The core is the site's.** Anything that changes how numbers are calculated (a tariff input, EPC, floor area) is a change to fidesq.com's generated core, not to this repo.
- **Privacy.** Today the assistant sends chat messages to Anthropic and the privacy text says so. Each live service that receives visitor data (postcodes.io, Octopus) must be added to that text. Address-based lookups such as EPC would need a deliberate privacy decision and are not part of this plan.
- **Terms of use.** Check the terms of postcodes.io (especially for BT data) and of the Octopus API before shipping K4. GOV.UK's Content API is open under the Open Government Licence but is documented as beta.
- **Third-party outages** must never break the chat; that is why every lookup has a timeout and a fallback.
- **One replica.** The caches and rate limiter live in memory. Fine for one service instance; move them to Redis before scaling out.
- **Cost.** K1 to K3 add no running cost. K4 adds a few network calls per chat. K5 with embeddings would add cost and a dependency.

## 7. Open questions to settle before or during the work

1. Does Ofgem offer a machine-readable feed for the price cap? (Decides whether K3 can automate it.)
2. What are the exact field names in the GOV.UK Content API response (`public_updated_at`, `details.body`)?
3. How does an Octopus tariff code encode the region, and what are the API's rate limits and terms?
4. Does postcodes.io's outward-code lookup return every country an outward code touches?
5. Will Laurie add an electricity-rate input to the core (decides K4b)?
6. Is a weekly scheduled Claude task acceptable for K3, or does he prefer Railway cron or GitHub Actions?

## 8. Suggested order

K1 first (it is useful on its own and everything else builds on it), then K2 (small, catches silent drift), then K3. Do K4 and K5 only when there is evidence they are needed: K4a if nation mistakes show up, K4b if Laurie wants tariff comparisons and agrees to extend the core, K5 if the guide outgrows the prompt.

When a step is finished, add a line at the top of its section ("Built in PR #N, merged DATE") and note anything that turned out differently.

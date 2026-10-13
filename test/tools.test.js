import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from '../core/load-core.js';
import { parsePlace } from '../shared/place.js';
import { sanitizeDetails, missingFields, createAgentTools, summarizeEstimate } from '../shared/agent-tools.js';
import { buildSystemPrompt } from '../shared/prompt.js';

const core = loadCore();
const TODAY = new Date('2026-10-13T12:00:00Z');
const SEMI = { nation: 'england', propertyType: 'semi_detached', bedrooms: 3, currentHeating: 'gas', ownership: 'owner_occupier' };

test('core matches the figures published on fidesq.com', () => {
  const d = core.estimate(SEMI, TODAY);
  // FAQ: "After the £7,500 grant, a typical gas-heated three-bed semi pays about £2,990 to £7,230."
  assert.deepEqual(d.installAfterGrant, { low: 2990, high: 7230 });
  assert.equal(d.grant.amount, 7500);
  assert.equal(d.grant.status, 'likely');
  // Running costs table: heat pump £800, gas £870 for a typical 3-bed semi.
  assert.equal(d.running.heatPumpAnnual, 800);
  assert.equal(d.running.currentAnnual, 870);
});

test('off-gas oil home gets £9,000 while the uplift runs', () => {
  const d = core.estimate({ ...SEMI, currentHeating: 'oil', hasMainsGas: false }, TODAY);
  assert.equal(d.grant.amount, 9000);
  const after = core.estimate({ ...SEMI, currentHeating: 'oil', hasMainsGas: false }, new Date('2027-04-02'));
  assert.equal(after.grant.amount, 7500);
});

test('parsePlace keeps only the outward code and finds the nation', () => {
  assert.deepEqual(parsePlace('le2 3ws'), { place: 'LE2', nation: 'england', isPostcode: true });
  assert.equal(parsePlace('EH1 1AA').nation, 'scotland');
  assert.equal(parsePlace('CF10').nation, 'wales');
  assert.equal(parsePlace('BT7').nation, 'northern_ireland');
  assert.equal(parsePlace('TD15 1AA').nation, 'england');
  assert.equal(parsePlace('CH1').nation, null); // straddles the border
  assert.deepEqual(parsePlace('  York  '), { place: 'York', nation: null, isPostcode: false });
});

test('sanitizeDetails accepts valid values and reports bad ones', () => {
  const { details, rejected } = sanitizeDetails({
    propertyType: 'castle', bedrooms: 9, currentHeating: 'gas', annualHeatingCostGbp: '£1,100', place: 'LE2 3WS', nation: 'wales', junk: 'x',
  });
  assert.equal(details.propertyType, undefined);
  assert.equal(details.bedrooms, 5);
  assert.equal(details.annualHeatingCostGbp, 1100);
  assert.equal(details.place, 'LE2');
  assert.equal(details.nation, 'england', 'a postcode overrides a stated nation, as on the site');
  assert.equal('junk' in details, false);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0], /propertyType/);
});

test('sanitizeDetails rejects odd place text and drops mains gas for gas homes', () => {
  assert.equal(sanitizeDetails({ place: '<script>alert(1)</script>' }).details.place, undefined);
  assert.equal(sanitizeDetails({ currentHeating: 'gas', hasMainsGas: false }).details.hasMainsGas, undefined);
  assert.equal(sanitizeDetails({ currentHeating: 'oil', hasMainsGas: false }).details.hasMainsGas, false);
  assert.equal(sanitizeDetails({ annualHeatingCostGbp: 999999 }).details.annualHeatingCostGbp, undefined);
  assert.equal(sanitizeDetails({ bedrooms: null }, { bedrooms: 3 }).details.bedrooms, undefined);
  assert.deepEqual(sanitizeDetails('nope').details, {});
});

test('tools: update, estimate, what-if', () => {
  let details = {};
  const checks = [];
  const tools = createAgentTools({ core, getDetails: () => details, setDetails: (d) => { details = d; }, onCheck: (c) => checks.push(c), today: TODAY });
  const [update, estimate, compare] = tools;

  const r1 = update.execute({ place: 'Leicester', nation: 'england', propertyType: 'semi_detached' });
  assert.equal(r1.readyToEstimate, false);
  assert.deepEqual(r1.stillToAsk.map((g) => g.field), ['bedrooms', 'currentHeating', 'ownership', 'annualHeatingCostGbp']);
  assert.throws(() => estimate.execute({}), /Still need: bedrooms, currentHeating/);

  update.execute({ bedrooms: 3, currentHeating: 'gas', annualHeatingCostGbp: 1100, ownership: 'owner_occupier' });
  const r2 = estimate.execute({});
  assert.deepEqual(r2.installAfterGrant, { low: 2990, high: 7230 });
  assert.equal(r2.runningCostsPerYear.heatPumpCost, 1050);
  assert.equal(r2.runningCostsPerYear.currentHeatingCost, 1100);

  const r3 = compare.execute({ annualHeatingCostGbp: 1500 });
  assert.equal(r3.estimate.runningCostsPerYear.currentHeatingCost, 1500);
  assert.equal(details.annualHeatingCostGbp, 1100, 'a what-if must not change the saved details');
  assert.ok(checks.length >= 4);
  assert.ok(JSON.stringify(r2).length < 8000, 'tool results stay small');
});

test('summary carries every number the assistant may quote', () => {
  const s = summarizeEstimate(core.estimate(SEMI, TODAY));
  for (const key of ['installBeforeGrant', 'installAfterGrant', 'grant', 'runningCostsPerYear', 'allHeatingTypesPerYear', 'versusNewBoiler']) {
    assert.ok(s[key], key);
  }
});

test('missingFields and prompt', () => {
  assert.deepEqual(missingFields({}), ['nation', 'propertyType', 'bedrooms', 'currentHeating']);
  const p = buildSystemPrompt({ details: { bedrooms: 3 }, today: TODAY });
  assert.match(p, /Today is 2026-10-13/);
  assert.match(p, /"bedrooms":3/);
});

// ── Gaps and questions ─────────────────────────────────────────

import { findGaps, sanitizeAsked, fallbackQuestion } from '../shared/agent-tools.js';

// The example from the screenshot: Inverness, bungalow, oil, no mains gas.
const INVERNESS = { place: 'Inverness', nation: 'scotland', propertyType: 'bungalow', currentHeating: 'oil', hasMainsGas: false };

test('gaps: the Inverness example is missing bedrooms, ownership and spend, in that order', () => {
  assert.deepEqual(findGaps(INVERNESS).map((g) => g.field), ['bedrooms', 'ownership', 'annualHeatingCostGbp']);
  assert.equal(findGaps(INVERNESS)[0].required, true);
  assert.deepEqual(findGaps(INVERNESS)[0].replies, ['1 bedroom', '2 bedrooms', '3 bedrooms', '4 bedrooms', '5 or more bedrooms']);
});

test('gaps: where the home is, mains gas only for oil/LPG, and nothing once complete', () => {
  assert.equal(findGaps({})[0].field, 'place');
  assert.equal(findGaps({ nation: 'wales' }).some((g) => g.field === 'place'), false, 'a known nation is enough');
  assert.ok(findGaps({ ...SEMI, currentHeating: 'lpg' }).some((g) => g.field === 'hasMainsGas'));
  assert.equal(findGaps(SEMI).some((g) => g.field === 'hasMainsGas'), false);
  assert.deepEqual(findGaps({ ...SEMI, annualHeatingCostGbp: 1100 }), []);
});

test('gaps: optional details stop being asked after their limit, required ones never do', () => {
  const asked = { ownership: 2, annualHeatingCostGbp: 1, bedrooms: 9 };
  assert.deepEqual(findGaps(INVERNESS, asked).map((g) => g.field), ['bedrooms']);
  assert.deepEqual(findGaps(INVERNESS, { ownership: 1 }).map((g) => g.field), ['bedrooms', 'ownership', 'annualHeatingCostGbp']);
});

test('sanitizeAsked keeps only known fields and sensible counts', () => {
  assert.deepEqual(sanitizeAsked({ bedrooms: 2, ownership: '1', hack: 5, place: -3, annualHeatingCostGbp: 1e9 }), { bedrooms: 2, ownership: 1, annualHeatingCostGbp: 20 });
  assert.deepEqual(sanitizeAsked(null), {});
});

test('ask_visitor records the question, counts it, and refuses known details', () => {
  let details = { ...INVERNESS };
  let asked = {};
  let question = null;
  const tools = createAgentTools({
    core, today: TODAY,
    getDetails: () => details, setDetails: (d) => { details = d; },
    getAsked: () => asked, setAsked: (a) => { asked = a; }, onQuestion: (q) => { question = q; },
  });
  const ask = tools.find((t) => t.name === 'ask_visitor');
  assert.throws(() => ask.execute({ field: 'propertyType', question: 'What kind of home?' }), /already known/);
  assert.throws(() => ask.execute({ field: 'shoeSize', question: 'x' }), /Unknown field/);
  const out = ask.execute({ field: 'bedrooms', question: 'How many bedrooms does it have?' });
  assert.equal(out.shown, true);
  assert.deepEqual(asked, { bedrooms: 1 });
  assert.equal(question.field, 'bedrooms');
  assert.equal(question.replies.length, 5);
});

test('fallbackQuestion asks the first gap with a fixed question, or nothing', () => {
  const asked = {};
  const q = fallbackQuestion(INVERNESS, asked);
  assert.equal(q.field, 'bedrooms');
  assert.match(q.question, /bedrooms/);
  assert.deepEqual(asked, { bedrooms: 1 });
  assert.equal(fallbackQuestion({ ...SEMI, annualHeatingCostGbp: 900 }, {}), null);
});

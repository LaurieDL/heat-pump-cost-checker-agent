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
  assert.deepEqual(r1.missingForEstimate, ['bedrooms', 'currentHeating']);
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

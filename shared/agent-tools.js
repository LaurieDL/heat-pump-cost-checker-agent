// The agent's tools. The model never does arithmetic: every figure comes from
// HeatPumpCore.estimate(), the same code the fidesq.com form uses.
//
// Runs unchanged in the browser (prototype, page) and in Node (server).
// The tool objects have the shape the claude.ai `sample` capability takes
// ({ name, description, inputSchema, execute }); the server maps them to the
// Anthropic Messages API `tools` format.
import { parsePlace } from './place.js';

// Values and labels the page's form, the tool schemas and the sanitiser share.
export const FIELD_OPTIONS = {
  nation: [
    ['england', 'England'], ['wales', 'Wales'], ['scotland', 'Scotland'], ['northern_ireland', 'Northern Ireland'],
  ],
  propertyType: [
    ['semi_detached', 'Semi-detached house'], ['terraced', 'Terraced house'], ['detached', 'Detached house'],
    ['bungalow', 'Bungalow'], ['flat', 'Flat'],
  ],
  bedrooms: [[1, '1'], [2, '2'], [3, '3'], [4, '4'], [5, '5 or more']],
  currentHeating: [
    ['gas', 'Gas boiler'], ['oil', 'Oil boiler'], ['lpg', 'LPG boiler'], ['electric', 'Electric heaters'], ['other', 'Something else'],
  ],
  ownership: [
    ['owner_occupier', 'I own it and live there'], ['landlord', 'I own it and rent it out'],
    ['tenant', 'I rent it'], ['social_housing', "It's social housing"],
  ],
};

const ENUM_FIELDS = ['nation', 'propertyType', 'currentHeating', 'ownership'];
export const REQUIRED_FOR_ESTIMATE = ['nation', 'propertyType', 'bedrooms', 'currentHeating'];
const MAX_SPEND_GBP = 20000;
const PLACE_TEXT_RE = /^[\p{L} .'-]{1,50}$/u;

const enumValues = (field) => FIELD_OPTIONS[field].map(([v]) => v);

export function optionLabel(field, value) {
  const hit = FIELD_OPTIONS[field]?.find(([v]) => v === value);
  return hit ? hit[1] : '';
}

/**
 * Merge an untrusted patch (from the model or from a request body) into the
 * current details. Unknown fields are dropped; invalid values are reported
 * back so the model can correct itself. `null` clears a field.
 */
export function sanitizeDetails(patch, base = {}) {
  const details = { ...base };
  const rejected = [];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { details, rejected };

  for (const field of ENUM_FIELDS) {
    if (!(field in patch)) continue;
    const v = patch[field];
    if (v === null) delete details[field];
    else if (enumValues(field).includes(v)) details[field] = v;
    else rejected.push(`${field}: "${String(v).slice(0, 40)}" is not one of ${enumValues(field).join(', ')}`);
  }

  if ('bedrooms' in patch) {
    const n = patch.bedrooms === null ? null : Math.round(Number(patch.bedrooms));
    if (n === null) delete details.bedrooms;
    else if (Number.isFinite(n) && n >= 1) details.bedrooms = Math.min(n, 5);
    else rejected.push('bedrooms: must be a whole number, 1 or more');
  }

  if ('annualHeatingCostGbp' in patch) {
    const raw = patch.annualHeatingCostGbp;
    const n = raw === null || raw === '' ? null : Number(String(raw).replace(/[£,\s]/g, ''));
    if (n === null || n === 0) delete details.annualHeatingCostGbp;
    else if (Number.isFinite(n) && n > 0 && n <= MAX_SPEND_GBP) details.annualHeatingCostGbp = Math.round(n);
    else rejected.push(`annualHeatingCostGbp: must be a yearly amount in pounds between 1 and ${MAX_SPEND_GBP}`);
  }

  for (const field of ['hasMainsGas', 'isNewBuild']) {
    if (!(field in patch)) continue;
    const v = patch[field];
    if (v === null) delete details[field];
    else if (typeof v === 'boolean') details[field] = v;
    else rejected.push(`${field}: must be true or false`);
  }

  if ('place' in patch) {
    if (patch.place === null || patch.place === '') delete details.place;
    else {
      const parsed = parsePlace(patch.place);
      if (parsed.isPostcode) {
        details.place = parsed.place; // outward code only, never the full postcode
        if (parsed.nation) details.nation = parsed.nation;
      } else if (parsed.place && PLACE_TEXT_RE.test(parsed.place)) {
        details.place = parsed.place;
      } else {
        rejected.push('place: give a town name or the first half of a postcode');
      }
    }
  }

  // The mains gas question only matters for oil and LPG homes (the core ignores it otherwise).
  if (details.currentHeating !== 'oil' && details.currentHeating !== 'lpg') delete details.hasMainsGas;

  return { details, rejected };
}

export function missingFields(details) {
  return REQUIRED_FOR_ESTIMATE.filter((f) => details[f] === undefined);
}

/** The full estimate the page renders, or null while required details are missing. */
export function runEstimate(core, details, today = new Date()) {
  if (missingFields(details).length) return null;
  return core.estimate(details, today);
}

/** A small plain-data version of an estimate for the model to read. */
export function summarizeEstimate(d) {
  return {
    home: d.home.description,
    heatPumpSize: d.size.band,
    installBeforeGrant: d.installBeforeGrant,
    grant: {
      scheme: d.grant.scheme,
      status: d.grant.status,
      amount: d.grant.amount,
      upTo: d.grant.upTo ?? null,
      deadline: d.grant.deadline ?? null,
      reasons: d.grant.reasons,
    },
    installAfterGrant: d.installAfterGrant,
    runningCostsPerYear: {
      basis: d.running.basis,
      currentHeating: d.running.currentFuel,
      currentHeatingCost: d.running.currentAnnual,
      heatPumpCost: d.running.heatPumpAnnual,
      heatPumpCheaperBy: d.running.difference,
      heatPumpCheaperByIfGasKeptConnected: d.running.differenceKeepingGas,
      gasStandingChargeSavedIfDisconnected: d.running.gasStandingCharge,
      note: d.running.note,
    },
    allHeatingTypesPerYear: Object.fromEntries(d.comparison.map((c) => [c.label, c.annual])),
    versusNewBoiler: d.vsNewBoiler,
    mainBenefit: d.benefit,
    carbonCutPercent: d.carbonCutPercent,
    keyFactors: d.keyFactors,
    summary: d.summary,
    vat: d.vatNote,
    outOfDateFigures: d.warnings,
    pricesCheckedOn: d.pricesCheckedOn,
  };
}

const DETAIL_PROPERTIES = {
  place: { type: 'string', description: 'Town, or the first half of a UK postcode (e.g. "LE2"). Never ask for a full postcode.' },
  nation: { type: 'string', enum: enumValues('nation'), description: 'Set this from the town if you know which nation it is in.' },
  propertyType: { type: 'string', enum: enumValues('propertyType') },
  bedrooms: { type: 'integer', minimum: 1, maximum: 5, description: '5 means 5 or more.' },
  currentHeating: { type: 'string', enum: enumValues('currentHeating'), description: '"other" for anything else, including an existing heat pump or biomass boiler.' },
  ownership: { type: 'string', enum: enumValues('ownership'), description: 'owner_occupier = owns and lives there; landlord = owns and rents it out.' },
  annualHeatingCostGbp: { type: 'number', description: 'What they spend a year on heating and hot water, in pounds. Optional.' },
  hasMainsGas: { type: 'boolean', description: 'Oil or LPG homes only: is the home connected to mains gas?' },
  isNewBuild: { type: 'boolean', description: 'True only for a new build home.' },
};

/**
 * Build the tool list for one conversation.
 *
 * @param {object} o
 * @param {object} o.core              HeatPumpCore
 * @param {() => object} o.getDetails  current details
 * @param {(d: object) => void} o.setDetails
 * @param {(c: {label: string, source?: string}) => void} [o.onCheck]  progress line for the page
 * @param {Date} [o.today]
 */
export function createAgentTools({ core, getDetails, setDetails, onCheck = () => {}, today = new Date() }) {
  const describe = (d) => {
    const parts = [];
    if (d.bedrooms) parts.push(`${d.bedrooms === 5 ? '5+' : d.bedrooms}-bed`);
    if (d.propertyType) parts.push(optionLabel('propertyType', d.propertyType).toLowerCase());
    if (d.place) parts.push(`in ${d.place}`);
    if (d.currentHeating) parts.push(`· ${optionLabel('currentHeating', d.currentHeating).toLowerCase()}`);
    return parts.join(' ');
  };

  return [
    {
      name: 'update_home_details',
      description:
        "Record details the visitor has told you about their home. Call it whenever they give any detail, passing only the fields you learned. Returns the full saved details, which required fields are still missing, and any values that were rejected.",
      inputSchema: { type: 'object', properties: DETAIL_PROPERTIES },
      execute(input) {
        const { details, rejected } = sanitizeDetails(input, getDetails());
        setDetails(details);
        onCheck({ label: `Noted: ${describe(details) || 'your details'}` });
        return { details, missingForEstimate: missingFields(details), rejected };
      },
    },
    {
      name: 'estimate_heat_pump',
      description:
        "Work out the heat pump estimate from the saved details: installed cost before and after the grant, grant eligibility, and yearly running costs against every heating type. Call it once nation, propertyType, bedrooms and currentHeating are saved, and again after details change. The page shows the full result to the visitor.",
      inputSchema: { type: 'object', properties: {} },
      execute() {
        const details = getDetails();
        const missing = missingFields(details);
        if (missing.length) throw new Error(`Still need: ${missing.join(', ')}. Ask the visitor for these first.`);
        const d = core.estimate(details, today);
        onCheck({ label: `Priced a typical ${d.size.band} install`, source: 'DESNZ Boiler Upgrade Scheme statistics' });
        onCheck({ label: `Grant: ${d.grant.scheme}, ${d.grant.status}`, source: 'GOV.UK' });
        onCheck({ label: `Running costs (${d.running.basis})`, source: 'Ofgem price cap, Oct–Dec 2026' });
        return summarizeEstimate(d);
      },
    },
    {
      name: 'compare_scenario',
      description:
        "Answer a what-if without changing the visitor's saved details: re-run the estimate with some fields changed (for example a different yearly spend, heating type or ownership). Returns the scenario's estimate. Use it for questions like 'what if we spent £1,500 a year?'.",
      inputSchema: { type: 'object', properties: DETAIL_PROPERTIES },
      execute(input) {
        const { details, rejected } = sanitizeDetails(input, getDetails());
        const missing = missingFields(details);
        if (missing.length) throw new Error(`Still need: ${missing.join(', ')}.`);
        onCheck({ label: 'Compared a what-if scenario' });
        return { scenario: details, rejected, estimate: summarizeEstimate(core.estimate(details, today)) };
      },
    },
  ];
}

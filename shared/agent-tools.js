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

// ── Gaps: what the assistant still has to ask, in the order to ask it ──
//
// `maxAsks` stops the assistant nagging: required details are asked until
// answered; the rest at most this many times (a visitor who says "not sure"
// is not asked again).
export const QUESTIONS = {
  place: {
    label: 'Where the home is', required: true, maxAsks: Infinity,
    hint: 'Ask where the home is: a town, or the first half of the postcode. This sets which grant applies.',
    fallback: 'Where is the home? A town or the first half of the postcode is enough.',
    replies: [],
  },
  propertyType: {
    label: 'Property type', required: true, maxAsks: Infinity,
    hint: 'Ask what kind of home it is.',
    fallback: 'What kind of home is it?',
    replies: FIELD_OPTIONS.propertyType.map(([, l]) => l),
  },
  bedrooms: {
    label: 'Bedrooms', required: true, maxAsks: Infinity,
    hint: 'Ask how many bedrooms it has. Size sets the heat pump size and so the price.',
    fallback: 'How many bedrooms does it have?',
    replies: ['1 bedroom', '2 bedrooms', '3 bedrooms', '4 bedrooms', '5 or more bedrooms'],
  },
  currentHeating: {
    label: 'Current heating', required: true, maxAsks: Infinity,
    hint: 'Ask how the home is heated now.',
    fallback: 'How is the home heated now?',
    replies: FIELD_OPTIONS.currentHeating.map(([, l]) => l),
  },
  ownership: {
    label: 'Ownership', required: false, maxAsks: 2,
    hint: 'Ask whether they own the home. It decides whether they can get the grant.',
    fallback: 'Do you own the home? That decides whether you can get the grant.',
    replies: FIELD_OPTIONS.ownership.map(([, l]) => l),
  },
  hasMainsGas: {
    label: 'Mains gas connection', required: false, maxAsks: 1,
    hint: 'Ask whether the home is connected to mains gas. Oil and LPG homes without it get the bigger £9,000 grant.',
    fallback: 'Is the home connected to mains gas? Oil and LPG homes without it can get £9,000 instead of £7,500.',
    replies: ['No mains gas', "Yes, there's mains gas", 'Not sure'],
  },
  annualHeatingCostGbp: {
    label: 'Yearly heating spend', required: false, maxAsks: 1,
    hint: 'Ask roughly what they spend a year on heating and hot water, so running costs are based on their home. Say it is optional.',
    fallback: 'Roughly what do you spend a year on heating and hot water? It makes the running costs fit your home. Skip it if you are not sure.',
    replies: ["Not sure, skip this"],
  },
};
const QUESTION_FIELDS = Object.keys(QUESTIONS);

/** Sanitise the page's record of how often each detail has been asked. */
export function sanitizeAsked(raw) {
  const asked = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return asked;
  for (const f of QUESTION_FIELDS) {
    const n = Math.floor(Number(raw[f]));
    if (Number.isFinite(n) && n > 0) asked[f] = Math.min(n, 20);
  }
  return asked;
}

function isGap(field, details) {
  switch (field) {
    case 'place': return details.nation === undefined; // a known nation is enough for the estimate
    case 'hasMainsGas': return (details.currentHeating === 'oil' || details.currentHeating === 'lpg') && details.hasMainsGas === undefined;
    default: return details[field] === undefined;
  }
}

/**
 * The details still missing, most important first, leaving out any already
 * asked as often as allowed. Each entry: { field, label, required, hint, replies }.
 */
export function findGaps(details, asked = {}) {
  return QUESTION_FIELDS
    .filter((f) => isGap(f, details) && (asked[f] ?? 0) < QUESTIONS[f].maxAsks)
    .map((f) => ({ field: f, label: QUESTIONS[f].label, required: QUESTIONS[f].required, hint: QUESTIONS[f].hint, replies: QUESTIONS[f].replies }));
}

/**
 * Safety net: if the assistant still hasn't asked about a gap, ask the first
 * one with a fixed question. Returns the question (and counts it as asked), or null.
 */
export function fallbackQuestion(details, asked) {
  const gap = findGaps(details, asked)[0];
  if (!gap) return null;
  asked[gap.field] = (asked[gap.field] ?? 0) + 1;
  return { field: gap.field, question: QUESTIONS[gap.field].fallback, replies: gap.replies };
}

const gapsForModel = (gaps) => gaps.map(({ field, required, hint }) => ({ field, required, hint }));

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
 * @param {() => object} [o.getAsked]  how often each detail has been asked so far
 * @param {(a: object) => void} [o.setAsked]
 * @param {(q: {field: string, question: string, replies: string[]}) => void} [o.onQuestion]
 *        called when the assistant asks the visitor something; the turn should end there
 * @param {Date} [o.today]
 */
export function createAgentTools({
  core, getDetails, setDetails, onCheck = () => {},
  getAsked = () => ({}), setAsked = () => {}, onQuestion = () => {}, today = new Date(),
}) {
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
        "Record details the visitor has told you about their home. Call it whenever they give any detail, passing only the fields you learned. Returns the full saved details, any values that were rejected, and stillToAsk: the details still missing, most important first.",
      inputSchema: { type: 'object', properties: DETAIL_PROPERTIES },
      execute(input) {
        const { details, rejected } = sanitizeDetails(input, getDetails());
        setDetails(details);
        onCheck({ label: `Noted: ${describe(details) || 'your details'}` });
        return { details, rejected, readyToEstimate: missingFields(details).length === 0, stillToAsk: gapsForModel(findGaps(details, getAsked())) };
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
        return { ...summarizeEstimate(d), stillToAsk: gapsForModel(findGaps(details, getAsked())) };
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
    {
      name: 'ask_visitor',
      description:
        "Ask the visitor for ONE missing detail from stillToAsk. The question is shown in the chat with tap-to-answer options, and your turn ends there, so call it last, after any other tools. Ask the first item in stillToAsk unless the conversation makes another more natural. Don't also write the question in your reply.",
      inputSchema: {
        type: 'object',
        properties: {
          field: { type: 'string', enum: QUESTION_FIELDS, description: 'Which detail you are asking for.' },
          question: { type: 'string', description: 'One short, friendly question in plain UK English, e.g. "How many bedrooms does it have?"' },
        },
        required: ['field', 'question'],
      },
      execute(input) {
        const field = String(input.field ?? '');
        const question = String(input.question ?? '').trim().slice(0, 300);
        if (!QUESTIONS[field]) throw new Error(`Unknown field. Ask one of: ${QUESTION_FIELDS.join(', ')}`);
        if (!question) throw new Error('Write the question to show the visitor.');
        if (!isGap(field, getDetails())) throw new Error(`${field} is already known. Pick another from stillToAsk, or don't ask.`);
        const asked = { ...getAsked() };
        asked[field] = (asked[field] ?? 0) + 1;
        setAsked(asked);
        onQuestion({ field, question, replies: QUESTIONS[field].replies });
        return { shown: true, note: 'The visitor sees your question now. End your turn without writing anything else.' };
      },
    },
  ];
}

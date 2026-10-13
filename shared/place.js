// Postcode area to nation, ported unchanged in behaviour from fidesq.com's
// /assets/js/heat-pump.js (parsePlace). Runs in the browser and in Node.
// Only the first half of a postcode is ever kept.

const SCOTLAND_AREAS = ['AB', 'DD', 'DG', 'EH', 'FK', 'G', 'HS', 'IV', 'KA', 'KW', 'KY', 'ML', 'PA', 'PH', 'ZE', 'TD'];
const WALES_AREAS = ['CF', 'LD', 'LL', 'NP', 'SA'];
const BORDER_AREAS = ['CH', 'HR', 'SY'];
const POSTCODE_RE = /^([A-Z]{1,2})(\d[A-Z\d]?)(\s*\d[A-Z]{2})?$/;

export function parsePlace(raw) {
  const text = String(raw ?? '').trim().replace(/\s+/g, ' ');
  const m = text.toUpperCase().match(POSTCODE_RE);
  if (!m) return { place: text || undefined, nation: null, isPostcode: false };
  const area = m[1];
  const outward = area + m[2];
  let nation = null;
  if (area === 'BT') nation = 'northern_ireland';
  else if (area === 'TD') nation = outward === 'TD15' ? 'england' : 'scotland';
  else if (SCOTLAND_AREAS.includes(area)) nation = 'scotland';
  else if (WALES_AREAS.includes(area)) nation = 'wales';
  else if (!BORDER_AREAS.includes(area)) nation = 'england';
  return { place: outward, nation, isPostcode: true };
}

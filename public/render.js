// Renders a HeatPumpCore.estimate() result. Wording follows fidesq.com's
// /assets/js/heat-pump.js so the page and the form say the same things.
// Every value is escaped; no inline style attributes (the server's CSP forbids them).

const MCS_SEARCH_URL = 'https://mcscertified.com/find-an-installer/?utm_source=fidesq&utm_medium=calculator&utm_campaign=heat-pump';
const MCS_INFO_URL = 'https://mcscertified.com/consumers/';

export function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
export function fmtGbp(n) { return '£' + Math.round(n).toLocaleString('en-GB'); }
function fmtLongDate(iso) {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}
function capFirst(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function extLink(url, text) { return `<a href="${escHtml(url)}" target="_blank" rel="noopener">${escHtml(text)}</a>`; }
const tickSvg = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5 10 17 19 7"/></svg>';

function headCard(d) {
  const g = d.grant;
  const v = d.vsNewBoiler;
  const current = d.comparison.find((c) => c.isCurrent);
  const replacing = current && ['gas', 'oil', 'lpg'].includes(current.fuel) ? 'replacing your ' + current.label.toLowerCase() : 'a new boiler';
  const price = d.installAfterGrant || d.installBeforeGrant;
  const line = !d.installAfterGrant
    ? `${g.claimant ? 'Before the grant, which your landlord would claim.' : 'No grant.'} About ${fmtGbp(v.gapBeforeGrant)} more than ${replacing}.`
    : v.gapAfterGrant === 0
      ? `After the ${fmtGbp(g.amount)} grant. About the same as ${replacing}.`
      : `After the ${fmtGbp(g.amount)} grant. About ${fmtGbp(v.gapAfterGrant)} more than ${replacing}.`;
  const before = d.installAfterGrant
    ? `Before the grant: ${fmtGbp(d.installBeforeGrant.low)} to ${fmtGbp(d.installBeforeGrant.high)} for a typical ${escHtml(d.size.band)} system.`
    : `Full installed price for a typical ${escHtml(d.size.band)} system.`;
  const yes = g.status === 'likely' || g.status === 'check' || Boolean(g.claimant);
  const pill = g.status === 'likely' ? `Likely to get the ${fmtGbp(g.amount)} grant`
    : g.status === 'check' ? `May get the ${fmtGbp(g.amount)} grant` : g.status === 'none' ? 'No grant in Northern Ireland' : g.availability || 'Unlikely to get the grant';
  return `<div class="result-head">
    <p class="eyebrow">Heat pump estimate</p>
    <h2>${escHtml(d.home.description)}</h2>
    <p class="sub">Typical ${escHtml(d.size.band)} air source heat pump${current ? ', compared with your ' + escHtml(current.label.toLowerCase()) : ''}</p>
    <p class="big">${fmtGbp(price.low)} to ${fmtGbp(price.high)}</p>
    <p class="line">${line}</p>
    <span class="status-pill${yes ? '' : ' no'}"><span class="dot"></span>${escHtml(pill)}</span>
    <p class="note">${before} ${escHtml(d.vatNote)}</p>
  </div>`;
}

function grantCard(d) {
  const g = d.grant;
  let title, sub, details = g.reasons, cls, pill;
  if (g.status === 'likely') {
    cls = 'yes'; pill = 'Likely';
    title = `You're likely to get a ${fmtGbp(g.amount)} grant`;
    sub = extLink(g.sourceUrl, g.scheme);
    if (g.upTo && g.upTo > g.amount) {
      const upTo = fmtGbp(g.upTo);
      sub += `. Or ${upTo} if your home has no mains gas${g.deadline ? ', until ' + fmtLongDate(g.deadline) : ''}.`;
      details = g.reasons.filter((x) => !x.includes(upTo));
    }
  } else if (g.status === 'check') {
    cls = 'yes'; pill = 'Worth checking';
    title = `You may get a ${fmtGbp(g.amount)} grant`;
    sub = extLink(g.sourceUrl, g.scheme) + '. Worth checking with an installer.';
  } else if (g.status === 'none') {
    cls = 'no'; pill = 'None';
    title = 'No heat pump grant in Northern Ireland';
    sub = "You'd pay the full installed price. Some help exists for lower-income households.";
    details = [];
  } else {
    cls = g.claimant ? 'yes' : 'no';
    pill = g.claimant ? 'Your landlord' : g.availability ? 'Not available' : 'Unlikely';
    title = escHtml(g.availability || "You're unlikely to get a grant");
    sub = escHtml(g.reasons[0] || '');
    details = g.reasons.slice(1);
  }
  return `<div class="card card-pad rcard">
    <p class="eyebrow">Grant <span class="pill ${cls}">${pill}</span></p>
    <p class="title">${title}</p>
    <p class="sub">${sub}</p>
    ${details.length ? `<ul class="small">${details.map((x) => `<li>${escHtml(x)}</li>`).join('')}</ul>` : ''}
  </div>`;
}

function runningCard(d) {
  const r = d.running;
  const current = d.comparison.find((c) => c.isCurrent);
  const hp = d.comparison.find((c) => c.fuel === 'heat_pump');
  let big;
  if (!current) big = `${fmtGbp(hp.annual)} a year`;
  else {
    const diff = r.difference === null ? current.annual - hp.annual : r.difference;
    big = Math.abs(diff) < 50 ? 'About the same'
      : Math.abs(diff) < 150 ? 'Heat pump ' + (diff > 0 ? 'cheaper' : 'dearer')
        : `${fmtGbp(Math.abs(diff))} a year ${diff > 0 ? 'cheaper' : 'dearer'}`;
  }
  const rows = d.comparison.slice().sort((a, b) => a.annual - b.annual);
  const max = Math.max(1, ...rows.map((c) => c.annual));
  const bars = rows.map((c) => `<div class="bar-row${c.fuel === 'heat_pump' ? ' is-hp' : ''}${c.isCurrent ? ' is-current' : ''}" role="listitem">
      <span class="lbl">${escHtml(c.label)}${c.isCurrent ? ' <span class="tag">You now</span>' : ''}</span>
      <span class="track"><span class="bar" data-pct="${((c.annual / max) * 100).toFixed(1)}"></span></span>
      <span class="amt">${fmtGbp(c.annual)}</span></div>`).join('');
  const gasNote = r.gasStandingCharge !== null && r.differenceKeepingGas !== null
    ? `<p class="note">The gas figure includes the ${fmtGbp(r.gasStandingCharge)} a year standing charge, which you only save if you disconnect gas. Keep the connection and the heat pump costs about ${fmtGbp(Math.abs(r.differenceKeepingGas))} a year ${r.differenceKeepingGas >= 0 ? 'less' : 'more'} than your boiler.</p>`
    : '';
  return `<div class="card card-pad rcard">
    <p class="eyebrow">Yearly heating and hot water</p>
    <p class="title">${escHtml(big)}</p>
    <p class="body">${current ? `Heat pump running costs against your ${escHtml(current.label.toLowerCase())}. Every type of heating, cheapest first, for the same home kept just as warm:` : 'Heat pump running cost for this home, with every other type of heating for comparison:'}</p>
    <div class="bars" role="list">${bars}</div>
    ${gasNote}
    ${r.note ? `<p class="note">${escHtml(r.note)}</p>` : ''}
    <p class="note">${r.basis === 'your bill' ? 'Based on the yearly spend you gave.' : 'Based on typical energy use for a home this size (Ofgem).'} Lights and appliances aren't included and don't change.</p>
  </div>`;
}

function benefitCard(d) {
  return `<div class="card card-pad rcard">
    <p class="eyebrow">Main benefit to you</p>
    <p class="title">${escHtml(capFirst(d.benefitHeadline))}</p>
    <p class="sub">${escHtml(d.benefit)}</p>
    ${d.environment ? `<p class="sub"><strong>Quite apart from cost:</strong> ${escHtml(d.environment.charAt(0).toLowerCase() + d.environment.slice(1))}</p>` : ''}
  </div>`;
}

function changesCard(d) {
  const items = [
    'A heat loss survey of your home. It sets the size of heat pump you need, which is the biggest single driver of price.',
    'Insulation. A well insulated home needs a smaller heat pump and costs less to run. Older homes may need some insulation first.',
    'Radiators and the hot water cylinder. Some radiators may need to be bigger, and a combi boiler home needs room for a cylinder.',
    'Your electricity tariff. A heat pump tariff can cut running costs a lot. We use the standard price cap.',
    'Your current boiler. We assume it is 90% efficient. Older boilers are often worse, which would make a heat pump look better.',
  ];
  return `<div class="card card-pad rcard">
    <p class="eyebrow">What could change this estimate</p>
    <p class="body"><strong>${escHtml(d.keyFactors)}</strong></p>
    ${d.summary ? `<p class="body">${escHtml(d.summary)}</p>` : ''}
    <ul class="small">${items.map((x) => `<li>${escHtml(x)}</li>`).join('')}</ul>
  </div>`;
}

function nextCard(d) {
  const grantNote = d.home.nation === 'england' || d.home.nation === 'wales' ? ' The installer applies for the grant for you.' : '';
  return `<div class="card card-pad rcard next">
    <p class="eyebrow">Next step</p>
    <p class="body">Get two or three quotes from ${extLink(MCS_INFO_URL, 'MCS certified')} installers. A good quote starts with a heat loss survey of your home.${grantNote}</p>
    <a class="btn-primary" href="${escHtml(MCS_SEARCH_URL)}" target="_blank" rel="noopener">Find an MCS certified installer</a>
  </div>`;
}

function sourcesCard(d, assumptions) {
  return `<details class="card card-pad rcard sources">
    <summary>Sources, dates and how this is worked out</summary>
    <ul class="small">${assumptions.map((x) => `<li>${escHtml(x)}</li>`).join('')}</ul>
    <ul class="small">${d.sources.map((s) => `<li>${extLink(s.url, s.label)}, checked ${fmtLongDate(s.checked)}</li>`).join('')}</ul>
  </details>`;
}

/** Fill `el` with the estimate. */
export function renderEstimate(el, d, assumptions) {
  el.innerHTML =
    (d.warnings.length ? `<p class="warn">Some prices here are out of date: ${escHtml(d.warnings.join('; '))}</p>` : '') +
    headCard(d) + grantCard(d) + runningCard(d) + benefitCard(d) + changesCard(d) + nextCard(d) + sourcesCard(d, assumptions);
  for (const bar of el.querySelectorAll('.bar[data-pct]')) bar.style.width = bar.dataset.pct + '%';
}

/** Minimal, safe formatting for the assistant's replies: paragraphs, **bold**, "- " lists. */
export function formatReply(text) {
  const inline = (s) => escHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;
  return String(text).trim().split(/\n{2,}/).map((block) => {
    // Group runs of bullet lines into lists, other runs into paragraphs.
    const out = [];
    let para = [];
    let list = [];
    const flushPara = () => { if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; };
    const flushList = () => { if (list.length) out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join('')}</ul>`); list = []; };
    for (const line of block.split('\n')) {
      if (BULLET.test(line)) { flushPara(); list.push(line.replace(BULLET, '')); }
      else if (line.trim()) { flushList(); para.push(line.replace(/^#+\s*/, '')); }
    }
    flushPara();
    flushList();
    return out.join('');
  }).join('');
}

export function renderChecks(checks) {
  if (!checks.length) return '';
  return `<p class="checks-title">What the assistant checked</p>` + checks.map((c) =>
    `<div class="check">${tickSvg}<span>${escHtml(c.label)}${c.source ? ` <span class="src">· ${escHtml(c.source)}</span>` : ''}</span></div>`).join('');
}

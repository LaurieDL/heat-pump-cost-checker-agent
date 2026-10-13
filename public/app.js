// Page controller: chat + "Your home" form + estimate.
// The chat and the form edit the same details. Every figure on the page is
// computed here by HeatPumpCore.estimate(); the assistant only fills in the
// details and explains. The transport decides where the agent runs.
import { FIELD_OPTIONS, sanitizeDetails, sanitizeAsked, missingFields, runEstimate, findGaps } from '/shared/agent-tools.js';
import { renderEstimate, formatReply, renderChecks } from './render.js';
import { createTransport } from './transport.js';

const core = window.HeatPumpCore;
const $ = (id) => document.getElementById(id);
const els = {
  log: $('hp-log'), chips: $('hp-chips'), compose: $('hp-compose'), input: $('hp-input'), send: $('hp-send'),
  reset: $('hp-reset'), form: $('hp-form'), count: $('hp-count'), empty: $('hp-empty'), result: $('hp-result'),
  mainsField: $('hp-mains-field'),
};
const FORM_IDS = { place: 'hp-place', nation: 'hp-nation', propertyType: 'hp-type', bedrooms: 'hp-beds', currentHeating: 'hp-fuel', hasMainsGas: 'hp-mains', ownership: 'hp-own', annualHeatingCostGbp: 'hp-bill' };
const COUNTED = ['place', 'propertyType', 'bedrooms', 'currentHeating', 'ownership'];
const MAX_TURNS_SENT = 24;

const GREETING = "Hi. Tell me about your home in a sentence or two: where it is, what kind of home, and how it's heated now. If you know roughly what you spend on heating a year, that helps too.";
const START_CHIPS = [
  '3-bed semi in Leicester, gas combi, about £1,100 a year',
  '2-bed terrace in Cardiff, we rent it',
  'Detached bungalow near Inverness on oil, no mains gas',
];
const FOLLOW_CHIPS = [
  'Is it cheaper to run than what I have now?',
  'What if we spend £1,500 a year on heating?',
  'How do I get the grant?',
  'What happens at the survey?',
];

const DEFAULT_PLACEHOLDER = 'e.g. 3-bed semi in York, gas combi, about £1,100 a year';
// Which form boxes to mark for each missing detail.
const GAP_FORM_FIELDS = { place: ['place', 'nation'] };

const state = { details: {}, asked: {}, turns: [], showResult: false, busy: false, controller: null, chatOn: true, started: false };
const transport = createTransport({ core });

// ── Form ────────────────────────────────────────────────────
function fillSelect(id, field) {
  const sel = $(id);
  sel.innerHTML = '<option value="">Choose…</option>' +
    FIELD_OPTIONS[field].map(([v, label]) => `<option value="${v}">${label}</option>`).join('');
}

function readForm() {
  const v = (f) => $(FORM_IDS[f]).value.trim();
  return {
    place: v('place') || null,
    nation: v('nation') || null,
    propertyType: v('propertyType') || null,
    bedrooms: v('bedrooms') ? Number(v('bedrooms')) : null,
    currentHeating: v('currentHeating') || null,
    hasMainsGas: v('hasMainsGas') ? v('hasMainsGas') === 'yes' : null,
    ownership: v('ownership') || null,
    annualHeatingCostGbp: v('annualHeatingCostGbp') || null,
  };
}

function writeForm(details, flash = []) {
  for (const [field, id] of Object.entries(FORM_IDS)) {
    const el = $(id);
    const val = details[field];
    let next = '';
    if (field === 'hasMainsGas') next = val === undefined ? '' : val ? 'yes' : 'no';
    else if (val !== undefined) next = String(val);
    // Don't fight the visitor while they're typing in a text box.
    if (el.value !== next && !(document.activeElement === el && el.tagName === 'INPUT')) el.value = next;
  }
  const oilOrLpg = details.currentHeating === 'oil' || details.currentHeating === 'lpg';
  els.mainsField.hidden = !oilOrLpg;
  markGaps(details);
  els.count.textContent = `${COUNTED.filter((f) => details[f] !== undefined).length} of ${COUNTED.length}`;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (const field of flash) {
    const box = els.form.querySelector(`[data-field="${field}"]`);
    if (!box || reduce) continue;
    box.classList.remove('just-set');
    void box.offsetWidth; // restart the animation
    box.classList.add('just-set');
  }
}

/** Mark the form boxes the assistant still needs, once the visitor has started. */
function markGaps(details) {
  for (const box of els.form.querySelectorAll('[data-field]')) delete box.dataset.gap;
  if (!state.started) return;
  // Respect what's been asked: a skipped optional detail stops being flagged.
  for (const gap of findGaps(details, state.asked)) {
    for (const f of GAP_FORM_FIELDS[gap.field] ?? [gap.field]) {
      const box = els.form.querySelector(`[data-field="${f}"]`);
      if (box && (f !== 'nation' || details.nation === undefined)) box.dataset.gap = gap.required ? 'needed' : 'optional';
    }
  }
}

function changedFields(before, after) {
  return Object.keys(FORM_IDS).filter((f) => before[f] !== after[f] && after[f] !== undefined);
}

function setDetails(next, { flash = false } = {}) {
  const changed = changedFields(state.details, next);
  state.details = next;
  writeForm(next, flash ? changed : []);
  if (state.showResult) renderResult();
}

let formTimer;
function onFormEdit() {
  clearTimeout(formTimer);
  formTimer = setTimeout(() => {
    state.started = true;
    const { details } = sanitizeDetails(readForm(), {});
    setDetails(details);
  }, 150);
}

// ── Estimate ────────────────────────────────────────────────
function renderResult() {
  const d = runEstimate(core, state.details);
  if (!d) {
    els.result.hidden = true;
    els.empty.hidden = false;
    return;
  }
  renderEstimate(els.result, d, core.ASSUMPTIONS);
  els.result.hidden = false;
  els.empty.hidden = true;
}

function showEstimateFromForm() {
  state.started = true;
  const { details } = sanitizeDetails(readForm(), {});
  setDetails(details);
  const missing = missingFields(details);
  if (missing.length) {
    const names = { nation: 'nation', propertyType: 'property type', bedrooms: 'bedrooms', currentHeating: 'current heating' };
    els.empty.querySelector('p').textContent = `To show an estimate we still need: ${missing.map((m) => names[m]).join(', ')}.`;
    $(FORM_IDS[missing[0]]).focus();
    return;
  }
  state.showResult = true;
  renderResult();
  if (matchMedia('(max-width: 899px)').matches) els.result.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

// ── Chat ────────────────────────────────────────────────────
function scrollLog() { els.log.scrollTop = els.log.scrollHeight; }

function addAgent(html) {
  const row = document.createElement('div');
  row.className = 'msg msg-agent';
  row.innerHTML = `<span class="avatar" aria-hidden="true">f</span><div class="bubble">${html}</div>`;
  els.log.append(row);
  scrollLog();
  return row.querySelector('.bubble');
}
function addUser(text) {
  const row = document.createElement('div');
  row.className = 'msg msg-user';
  row.textContent = text;
  els.log.append(row);
  scrollLog();
}
function addNote(text) {
  const row = document.createElement('p');
  row.className = 'msg-note';
  row.textContent = text;
  els.log.append(row);
  scrollLog();
}
function addChecks(checks) {
  if (!checks.length) return null;
  const box = document.createElement('div');
  box.className = 'checks';
  box.innerHTML = renderChecks(checks);
  els.log.append(box);
  scrollLog();
  return box;
}

function setChips(list) {
  els.chips.innerHTML = '';
  for (const text of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = text;
    b.disabled = state.busy || !state.chatOn;
    b.addEventListener('click', () => sendMessage(text));
    els.chips.append(b);
  }
}

function setBusy(busy) {
  state.busy = busy;
  els.send.disabled = busy || !state.chatOn;
  els.input.disabled = !state.chatOn;
  for (const b of els.chips.querySelectorAll('button')) b.disabled = busy || !state.chatOn;
}

function turnsToSend() {
  let t = state.turns.slice(-MAX_TURNS_SENT);
  while (t.length && t[0].role !== 'user') t = t.slice(1);
  return t;
}

async function sendMessage(raw) {
  const text = raw.trim().slice(0, 1200);
  if (!text || state.busy || !state.chatOn) return;
  state.started = true;
  els.input.value = '';
  els.input.placeholder = DEFAULT_PLACEHOLDER;
  autoGrow();
  addUser(text);
  state.turns.push({ role: 'user', content: text });
  setBusy(true);

  const bubble = addAgent('<span class="thinking" aria-label="Working it out"><i></i><i></i><i></i></span>');
  let liveChecks = [];
  let checksBox = null;
  const controller = new AbortController();
  state.controller = controller;

  try {
    const result = await transport.send({
      messages: turnsToSend(),
      details: state.details,
      asked: state.asked,
      signal: controller.signal,
      onText: (t) => { bubble.innerHTML = formatReply(t); scrollLog(); },
      onCheck: (c) => {
        liveChecks.push(c);
        checksBox?.remove();
        checksBox = addChecks(liveChecks);
      },
    });
    if (controller.signal.aborted) return;
    const question = result.question?.question ? result.question : null;
    if (result.text) bubble.innerHTML = formatReply(result.text);
    else bubble.closest('.msg').remove();
    // The model sees its own question next turn, so keep it in the history.
    state.turns.push({ role: 'assistant', content: [result.text, question?.question].filter(Boolean).join('\n\n') || '…' });
    if (!checksBox) checksBox = addChecks(result.checks ?? []);
    else { checksBox.remove(); checksBox = addChecks(result.checks ?? liveChecks); }
    state.asked = sanitizeAsked(result.asked);
    const details = sanitizeDetails(result.details ?? {}, {}).details;
    // Show the estimate as soon as the required details are in, whoever filled them.
    if (result.estimated || missingFields(details).length === 0) state.showResult = true;
    setDetails(details, { flash: true }); // re-renders the estimate when it's showing
    if (question) askQuestion(question);
    else setChips(state.showResult ? FOLLOW_CHIPS : START_CHIPS.slice(0, 1));
  } catch (err) {
    if (err?.code === 'cancelled' || controller.signal.aborted) return;
    // Keep any details the assistant saved before the failure.
    if (err?.details) setDetails(sanitizeDetails(err.details, {}).details, { flash: true });
    if (err?.asked) state.asked = sanitizeAsked(err.asked);
    if (err?.partial) bubble.innerHTML = formatReply(err.partial);
    else bubble.closest('.msg').remove();
    state.turns.pop(); // keep the history alternating; the visitor can resend
    addNote(err?.message || 'The assistant could not answer just now. Please try again.');
  } finally {
    if (state.controller === controller) {
      state.controller = null;
      setBusy(false);
    }
  }
}

/** Show the assistant's question with tap-to-answer replies. */
function askQuestion(q) {
  const bubble = addAgent(formatReply(q.question));
  bubble.classList.add('is-question');
  setChips(q.replies ?? []);
  els.input.placeholder = q.replies?.length ? 'Tap an answer or type your own' : 'Type your answer';
  if (!matchMedia('(max-width: 899px)').matches) els.input.focus({ preventScroll: true });
}

function resetAll() {
  state.controller?.abort();
  state.controller = null;
  state.turns = [];
  state.asked = {};
  state.started = false;
  state.showResult = false;
  els.input.placeholder = DEFAULT_PLACEHOLDER;
  els.log.innerHTML = '';
  els.form.reset();
  setDetails({});
  els.result.hidden = true;
  els.result.innerHTML = '';
  els.empty.hidden = false;
  els.empty.querySelector('p').textContent = "Installed cost before and after the grant, running costs against your current heating, whether you're likely to qualify, and what could change the figures.";
  addAgent(formatReply(GREETING));
  if (!state.chatOn) addNote("The assistant isn't available here. Use the Your home form instead: it gives the same estimate.");
  setChips(START_CHIPS);
  setBusy(false);
}

function autoGrow() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 140) + 'px';
}

// ── Wiring ──────────────────────────────────────────────────
function init() {
  if (!core) {
    addNote('The calculator could not load. Please reload the page.');
    return;
  }
  fillSelect('hp-nation', 'nation');
  fillSelect('hp-type', 'propertyType');
  fillSelect('hp-beds', 'bedrooms');
  fillSelect('hp-fuel', 'currentHeating');
  fillSelect('hp-own', 'ownership');

  els.form.addEventListener('input', onFormEdit);
  els.form.addEventListener('change', onFormEdit);
  els.form.addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(formTimer); showEstimateFromForm(); });
  els.compose.addEventListener('submit', (e) => { e.preventDefault(); sendMessage(els.input.value); });
  els.input.addEventListener('input', autoGrow);
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(els.input.value); }
  });
  els.reset.addEventListener('click', resetAll);

  resetAll();
  transport.available().then((ok) => {
    if (ok) return;
    state.chatOn = false;
    resetAll();
  }).catch(() => {});
}

init();

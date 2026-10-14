// One chat turn: run the Claude tool-use loop with the Anthropic Messages API.
// No SDK: Node's built-in fetch is enough for one endpoint.
//
// The loop keeps going until the assistant has either asked the visitor for
// the next missing detail (ask_visitor ends the turn) or there is nothing left
// to ask. If it stops with details still missing, it is nudged once with a
// message telling it to call ask_visitor; if even that fails, a fixed question
// is used, so a gap is never left unasked.
//
// Never force a tool with tool_choice { type: 'tool' } or { type: 'any' }:
// Sonnet 5.5, Opus 5.5 and Fable 5.1 reject both with a 400, which fails the
// whole turn. tool_choice { type: 'none' } is still allowed.
import { createAgentTools, sanitizeDetails, sanitizeAsked, findGaps, fallbackQuestion } from '../shared/agent-tools.js';
import { buildSystemPrompt, buildGapNudge } from '../shared/prompt.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export class AgentError extends Error {
  constructor(message, { status = 502, cause } = {}) {
    super(message, { cause });
    this.status = status;
  }
}

async function callClaude({ apiKey, body, fetchImpl, timeoutMs }) {
  let res;
  try {
    res = await fetchImpl(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': API_VERSION },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new AgentError('Could not reach the AI service', { cause: err });
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // 429/529 mean the service is busy; anything else is our problem. Never pass the body to the visitor.
    const busy = res.status === 429 || res.status === 529;
    throw new AgentError(busy ? 'The AI service is busy' : `AI service error ${res.status}`, {
      status: busy ? 503 : 502,
      cause: new Error(detail.slice(0, 500)),
    });
  }
  return res.json();
}

/**
 * @param {object} o
 * @param {object} o.core          HeatPumpCore
 * @param {Array<{role:'user'|'assistant', content:string}>} o.messages  validated chat history, ending on a user turn
 * @param {object} o.details       the page's current details (untrusted; sanitised here)
 * @param {object} [o.asked]       how often each detail has been asked (untrusted; sanitised here)
 * @returns {Promise<{text: string, details: object, asked: object, question: object|null, checks: Array, estimated: boolean}>}
 */
export async function runChatTurn({
  core, messages, details: rawDetails, asked: rawAsked, apiKey, model, maxTokens = 1024, maxToolRounds = 5,
  timeoutMs = 60_000, fetchImpl = fetch, today = new Date(),
}) {
  let details = sanitizeDetails(rawDetails).details;
  let asked = sanitizeAsked(rawAsked);
  const checks = [];
  let estimated = false;
  let question = null;

  const tools = createAgentTools({
    core,
    getDetails: () => details,
    setDetails: (d) => { details = d; },
    onCheck: (c) => checks.push(c),
    getAsked: () => asked,
    setAsked: (a) => { asked = a; },
    onQuestion: (q) => { question = q; },
    today,
  });
  const byName = new Map(tools.map((t) => [t.name, t]));
  const apiTools = tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
    ...(i === tools.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
  }));

  const convo = messages.map((m) => ({ role: m.role, content: m.content }));
  const system = buildSystemPrompt({ details, asked, today });
  let answer = ''; // the reply to what the visitor said
  let askText = ''; // any words the assistant wrote alongside its question
  let nudgeRound = false;
  let nudged = false;

  for (let round = 0; round <= maxToolRounds; round++) {
    const lastRound = round === maxToolRounds;
    // Last round: answer, no more tools. Unless it is the nudge round, which must still be able to ask.
    const toolChoice = lastRound && !nudgeRound ? { tool_choice: { type: 'none' } } : {};
    const response = await callClaude({
      apiKey, fetchImpl, timeoutMs,
      body: { model, max_tokens: maxTokens, system, tools: apiTools, ...toolChoice, messages: convo },
    });
    nudgeRound = false;

    const content = Array.isArray(response.content) ? response.content : [];
    const roundText = content.filter((b) => b.type === 'text').map((b) => b.text.trim()).filter(Boolean).join('\n\n');
    const toolUses = content.filter((b) => b.type === 'tool_use');

    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
      if (roundText) answer = roundText;
      // Ended the turn with details still to ask and no question: nudge once, asking for ask_visitor.
      const gaps = findGaps(details, asked);
      if (gaps.length && !nudged && round < maxToolRounds) {
        nudged = true;
        nudgeRound = true;
        convo.push(
          { role: 'assistant', content: content.length ? content : [{ type: 'text', text: '(no reply)' }] },
          { role: 'user', content: buildGapNudge(gaps) },
        );
        continue;
      }
      break;
    }

    // Earlier rounds' text alongside tool calls is usually "let me check" narration; only
    // keep text written in the same round as the question.
    const results = [];
    for (const use of toolUses) {
      const tool = byName.get(use.name);
      let resultContent;
      let isError = false;
      try {
        if (!tool) throw new Error(`Unknown tool ${use.name}`);
        if (use.name === 'ask_visitor' && question) throw new Error('Only one question per turn.');
        resultContent = JSON.stringify(await tool.execute(use.input ?? {}));
        if (use.name === 'estimate_heat_pump') estimated = true;
      } catch (err) {
        isError = true;
        resultContent = `Error: ${err.message}`;
      }
      results.push({ type: 'tool_result', tool_use_id: use.id, content: resultContent, ...(isError ? { is_error: true } : {}) });
    }

    if (question) {
      // The question ends the turn: the visitor answers it next.
      askText = roundText;
      break;
    }
    convo.push({ role: 'assistant', content }, { role: 'user', content: results });
  }

  // Safety net: never leave a gap unasked.
  if (!question) {
    const fallbackAsked = { ...asked };
    question = fallbackQuestion(details, fallbackAsked);
    if (question) asked = fallbackAsked;
  }

  const text = [answer, askText].filter(Boolean).join('\n\n');
  if (!text && !question) throw new AgentError('The AI service returned no answer');
  return { text, details, asked, question, checks, estimated };
}

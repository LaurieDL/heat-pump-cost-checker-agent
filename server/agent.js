// One chat turn: run the Claude tool-use loop with the Anthropic Messages API.
// No SDK: Node's built-in fetch is enough for one endpoint.
import { createAgentTools, sanitizeDetails } from '../shared/agent-tools.js';
import { buildSystemPrompt } from '../shared/prompt.js';

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
 * @returns {Promise<{text: string, details: object, checks: Array, estimated: boolean}>}
 */
export async function runChatTurn({
  core, messages, details: rawDetails, apiKey, model, maxTokens = 1024, maxToolRounds = 5,
  timeoutMs = 60_000, fetchImpl = fetch, today = new Date(),
}) {
  let details = sanitizeDetails(rawDetails).details;
  const checks = [];
  let estimated = false;

  const tools = createAgentTools({
    core,
    getDetails: () => details,
    setDetails: (d) => { details = d; },
    onCheck: (c) => checks.push(c),
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
  const system = buildSystemPrompt({ details, today });
  const texts = [];

  for (let round = 0; round <= maxToolRounds; round++) {
    const lastRound = round === maxToolRounds;
    const response = await callClaude({
      apiKey, fetchImpl, timeoutMs,
      body: {
        model,
        max_tokens: maxTokens,
        system,
        tools: apiTools,
        // On the last allowed round, make the model answer instead of calling more tools.
        ...(lastRound ? { tool_choice: { type: 'none' } } : {}),
        messages: convo,
      },
    });

    const content = Array.isArray(response.content) ? response.content : [];
    const roundText = content.filter((b) => b.type === 'text').map((b) => b.text.trim()).filter(Boolean).join('\n\n');
    if (roundText) texts.push(roundText);

    const toolUses = content.filter((b) => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) break;

    const results = [];
    for (const use of toolUses) {
      const tool = byName.get(use.name);
      let resultContent;
      let isError = false;
      try {
        if (!tool) throw new Error(`Unknown tool ${use.name}`);
        resultContent = JSON.stringify(await tool.execute(use.input ?? {}));
        if (use.name === 'estimate_heat_pump') estimated = true;
      } catch (err) {
        isError = true;
        resultContent = `Error: ${err.message}`;
      }
      results.push({ type: 'tool_result', tool_use_id: use.id, content: resultContent, ...(isError ? { is_error: true } : {}) });
    }
    convo.push({ role: 'assistant', content }, { role: 'user', content: results });
  }

  // The final round's text is the answer; earlier rounds are usually "let me check" narration.
  const text = texts.at(-1) ?? '';
  if (!text) throw new AgentError('The AI service returned no answer');
  return { text, details, checks, estimated };
}

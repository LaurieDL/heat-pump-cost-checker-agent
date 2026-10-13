// Prototype transport for claude.ai: the agent runs IN THE PAGE through the
// artifact `sample` capability (the viewer's own Claude account), using the
// same tools and instructions as the server. Only used by the prototype build.
// `sample` runs the tool rounds itself, so the server's nudge round isn't
// possible here; the same fixed-question safety net makes sure gaps are asked.
import { createAgentTools, sanitizeDetails, sanitizeAsked, fallbackQuestion } from '../shared/agent-tools.js';
import { buildSystemPrompt } from '../shared/prompt.js';

const SAMPLE_ERRORS = {
  not_granted: 'The assistant needs your permission to use Claude. Reload to be asked again, or use the form.',
  sampling_disabled: "Claude isn't available on this account, so the chat is off. The form still works.",
  rate_limited: "You've reached your Claude usage limit for now. Try again later, or use the form.",
  session_expired: 'Your Claude session has expired. Sign in again and reload.',
  refused: "The assistant couldn't answer that. Try asking another way.",
  tools_unavailable: "This view can't run the assistant's tools. The form still works.",
};

export function createTransport({ core }) {
  const samplePromise = window.claude?.use ? window.claude.use('sample') : Promise.resolve(null);

  return {
    async available() {
      const sample = await samplePromise;
      if (!sample) return false;
      const limits = await sample.limits().catch(() => null);
      return Boolean(limits?.tools);
    },

    async send({ messages, details, asked: rawAsked, signal, onText, onCheck }) {
      const sample = await samplePromise;
      if (!sample) throw { code: 'unavailable', message: 'The assistant only works inside Claude. Use the form instead.' };

      let current = sanitizeDetails(details).details;
      let asked = sanitizeAsked(rawAsked);
      let estimated = false;
      let question = null;
      const checks = [];
      const tools = createAgentTools({
        core,
        getDetails: () => current,
        setDetails: (d) => { current = d; },
        onCheck: (c) => { checks.push(c); onCheck?.(c); },
        getAsked: () => asked,
        setAsked: (a) => { asked = a; },
        onQuestion: (q) => { question = q; },
      }).map((t) => ({
        ...t,
        execute: (input) => {
          if (t.name === 'ask_visitor' && question) throw new Error('Only one question per turn.');
          const out = t.execute(input ?? {});
          if (t.name === 'estimate_heat_pump') estimated = true;
          return out;
        },
      }));

      const input = [
        { role: 'user', content: `${buildSystemPrompt({ details: current, asked })}\n\nThe visitor's conversation follows.` },
        ...messages,
      ];
      try {
        const { text } = await sample(input, { tools, signal, modelTier: 'quick', onText: ({ text: t }) => onText?.(t) });
        if (!question) {
          const fallbackAsked = { ...asked };
          question = fallbackQuestion(current, fallbackAsked);
          if (question) asked = fallbackAsked;
        }
        return { text, details: current, asked, question, checks, estimated };
      } catch (e) {
        throw { code: e?.code ?? 'upstream_error', message: SAMPLE_ERRORS[e?.code] ?? 'The assistant could not answer just now. Please try again.', partial: e?.text, details: current, asked, checks, estimated };
      }
    },
  };
}

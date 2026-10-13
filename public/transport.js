// Production transport: the page talks to this service's POST /api/chat,
// which holds the Anthropic API key and runs the agent loop.
// (The claude.ai prototype swaps this file for prototype/transport-sample.js.)

function apiBase() {
  const meta = document.querySelector('meta[name="hp-api-base"]');
  return (meta?.content ?? '').replace(/\/$/, '');
}

export function createTransport() {
  return {
    /** Whether the chat can be used at all in this view. */
    async available() { return true; },

    /**
     * @returns {Promise<{text: string, details: object, asked: object, question: object|null, checks: Array, estimated: boolean}>}
     */
    async send({ messages, details, asked, signal }) {
      let res;
      try {
        res = await fetch(`${apiBase()}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages, details, asked }),
          signal,
        });
      } catch (err) {
        if (err?.name === 'AbortError') throw { code: 'cancelled' };
        throw { code: 'network', message: "Couldn't reach the assistant. Check your connection and try again." };
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw { code: `http_${res.status}`, message: data.error || 'The assistant could not answer just now. Please try again.' };
      return data;
    },
  };
}

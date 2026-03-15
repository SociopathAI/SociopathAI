// LLMClient — routes LLM inference to the correct provider using the agent's own key.
// Keys are held in agent memory only; never written to disk or logged.

const VALID_ACTIONS = new Set([
  'gather_food', 'gather_material', 'rest', 'trade',
  'steal', 'pray', 'socialize', 'propose_law', 'work',
]);

const MODELS = {
  Anthropic: 'claude-haiku-4-5-20251001',
  OpenAI:    'gpt-4o-mini',
  Google:    'gemini-1.5-flash',
  Groq:      'llama-3.1-8b-instant',
  Llama:     'llama-3.1-8b-instant',   // via Groq endpoint
  Grok:      'grok-3-mini',
  Mistral:   'mistral-small-latest',
  Other:     'gpt-4o-mini',
};

const ENDPOINTS = {
  OpenAI:  'https://api.openai.com/v1/chat/completions',
  Groq:    'https://api.groq.com/openai/v1/chat/completions',
  Llama:   'https://api.groq.com/openai/v1/chat/completions',
  Grok:    'https://api.x.ai/v1/chat/completions',
  Mistral: 'https://api.mistral.ai/v1/chat/completions',
  Other:   'https://api.openai.com/v1/chat/completions',
};

class LLMClient {
  constructor(apiKey, aiSystem) {
    this.apiKey   = apiKey;
    this.aiSystem = aiSystem;
  }

  // Returns { action, dialogue } or null if call fails / response invalid
  async decide(systemPrompt, userPrompt, timeoutMs = 6000) {
    try {
      let text;
      if (this.aiSystem === 'Anthropic') {
        text = await this._anthropic(systemPrompt, userPrompt, timeoutMs);
      } else if (this.aiSystem === 'Google') {
        text = await this._google(systemPrompt, userPrompt, timeoutMs);
      } else {
        const url   = ENDPOINTS[this.aiSystem] || ENDPOINTS.Other;
        const model = MODELS[this.aiSystem]    || MODELS.Other;
        text = await this._openaiCompat(url, model, systemPrompt, userPrompt, timeoutMs);
      }
      return this._parse(text);
    } catch {
      return null;
    }
  }

  // ── OpenAI-compatible (OpenAI, Groq, Llama, Grok, Mistral, Other) ──────────

  async _openaiCompat(url, model, systemPrompt, userPrompt, timeoutMs) {
    const ctl = new AbortController();
    const t   = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method:  'POST',
        signal:  ctl.signal,
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userPrompt },
          ],
          response_format: { type: 'json_object' },
          max_tokens:  150,
          temperature: 0.85,
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data?.choices?.[0]?.message?.content ?? null;
    } finally {
      clearTimeout(t);
    }
  }

  // ── Anthropic ──────────────────────────────────────────────────────────────

  async _anthropic(systemPrompt, userPrompt, timeoutMs) {
    const ctl = new AbortController();
    const t   = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method:  'POST',
        signal:  ctl.signal,
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model:      MODELS.Anthropic,
          max_tokens: 150,
          system:     systemPrompt,
          messages:   [{ role: 'user', content: userPrompt }],
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data?.content?.[0]?.text ?? null;
    } finally {
      clearTimeout(t);
    }
  }

  // ── Google Gemini ──────────────────────────────────────────────────────────

  async _google(systemPrompt, userPrompt, timeoutMs) {
    const ctl = new AbortController();
    const t   = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.Google}:generateContent?key=${this.apiKey}`;
      const res = await fetch(url, {
        method:  'POST',
        signal:  ctl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            maxOutputTokens:  150,
            temperature:      0.85,
          },
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
    } finally {
      clearTimeout(t);
    }
  }

  // ── Parse ──────────────────────────────────────────────────────────────────

  _parse(text) {
    if (!text || typeof text !== 'string') return null;
    // Strip markdown fences if model wrapped the JSON
    const clean = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
    let obj;
    try { obj = JSON.parse(clean); } catch { return null; }

    // Normalise action (allow spaces and hyphens as separators)
    let action = typeof obj.action === 'string'
      ? obj.action.trim().toLowerCase().replace(/[\s-]+/g, '_')
      : null;
    if (!action || !VALID_ACTIONS.has(action)) return null;

    const dialogue = typeof obj.dialogue === 'string' && obj.dialogue.trim()
      ? obj.dialogue.trim().slice(0, 120)
      : null;

    return { action, dialogue };
  }
}

module.exports = LLMClient;

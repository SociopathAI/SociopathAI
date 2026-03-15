// SociopathAI — Browser-side LLM client
// API keys stay in sessionStorage; calls go DIRECTLY to the AI provider.
// The server never sees the key. Only the action string is sent back.
// If a direct call fails (CORS), a blind proxy on /api/llm-proxy is used as fallback.
// The proxy forwards the request without logging or storing the key.

(function () {

  const VALID_ACTIONS = new Set([
    'gather_food', 'gather_material', 'rest', 'trade',
    'steal', 'pray', 'socialize', 'propose_law', 'work',
  ]);

  const MODELS = {
    Claude:  'claude-haiku-4-5-20251001',
    ChatGPT: 'gpt-4o-mini',
    Gemini:  'gemini-1.5-flash',
    Groq:    'llama-3.1-8b-instant',
    Llama:   'llama-3.1-8b-instant',
    Grok:    'grok-3-mini',
    Mistral: 'mistral-small-latest',
    Other:   'gpt-4o-mini',
  };

  const OAI_ENDPOINTS = {
    ChatGPT: 'https://api.openai.com/v1/chat/completions',
    Groq:    'https://api.groq.com/openai/v1/chat/completions',
    Llama:   'https://api.groq.com/openai/v1/chat/completions',
    Grok:    'https://api.x.ai/v1/chat/completions',
    Mistral: 'https://api.mistral.ai/v1/chat/completions',
    Other:   'https://api.openai.com/v1/chat/completions',
  };

  // ── Prompt builder ─────────────────────────────────────────────────────────

  function buildPrompts(agentState, simState) {
    const t = agentState.traits;  // 0-100 ints from getSummary()
    const w = simState.world;
    const laws = (simState.laws || []).filter(l => l.active).map(l => l.text).slice(0, 4).join('; ') || 'none';
    const others = (simState.agents || [])
      .filter(a => a.alive && a.id !== agentState.id)
      .map(a => `${a.name}(hp:${a.health},food:${a.food})`)
      .join(', ') || 'none';

    const system =
      `You are ${agentState.name}, an autonomous agent in a primitive civilization simulation. ` +
      `Personality (0-100): Greed=${t.greed}, Piety=${t.piety}, Aggression=${t.aggression}, ` +
      `Sociability=${t.sociability}, Lawfulness=${t.lawfulness}, Creativity=${t.creativity}. ` +
      (agentState.educationNotes ? `Upbringing: "${agentState.educationNotes}". ` : '') +
      `Act true to your personality. Respond ONLY with a JSON object — no other text.`;

    const user =
      `Tick ${agentState.age} | ${w.season}, Year ${w.year}\n` +
      `World: food=${Math.round(w.food)}, material=${Math.round(w.material)}\n` +
      `You: Health=${agentState.health}%, Hunger=${agentState.hunger}%, ` +
      `Energy=${agentState.energy}%, Food=${agentState.food}, Material=${agentState.material}\n` +
      `Others: ${others}\nLaws: ${laws}\n` +
      (agentState.beliefs && agentState.beliefs.religion ? `Religion: ${agentState.beliefs.religion}\n` : '') +
      `\nChoose one: gather_food | gather_material | rest | trade | steal | pray | socialize | propose_law | work\n` +
      `{"action":"...","dialogue":"..."}  (dialogue = optional first-person quote ≤80 chars, or null)`;

    return { system, user };
  }

  // ── Response parser ────────────────────────────────────────────────────────

  function parseResponse(text) {
    if (!text || typeof text !== 'string') return null;
    const clean = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
    let obj;
    try { obj = JSON.parse(clean); } catch { return null; }

    let action = typeof obj.action === 'string'
      ? obj.action.trim().toLowerCase().replace(/[\s-]+/g, '_')
      : null;
    if (!action || !VALID_ACTIONS.has(action)) return null;

    const dialogue = typeof obj.dialogue === 'string' && obj.dialogue.trim()
      ? obj.dialogue.trim().slice(0, 120)
      : null;

    return { action, dialogue };
  }

  // ── Provider calls (direct, browser → API provider) ───────────────────────

  async function callAnthropic(apiKey, system, user, timeoutMs) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: ctl.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          // Required for browser-direct calls — Anthropic's explicit CORS opt-in
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: MODELS.Claude,
          max_tokens: 150,
          system,
          messages: [{ role: 'user', content: user }],
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data?.content?.[0]?.text ?? null;
    } finally {
      clearTimeout(t);
    }
  }

  async function callGoogle(apiKey, system, user, timeoutMs) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.Gemini}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        signal: ctl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 150, temperature: 0.85 },
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
    } finally {
      clearTimeout(t);
    }
  }

  async function callOpenAICompat(endpoint, model, apiKey, system, user, timeoutMs) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        signal: ctl.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          response_format: { type: 'json_object' },
          max_tokens: 150,
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

  // ── Proxy fallback (blind relay — key in transit only, never stored/logged) ─

  async function callViaProxy(aiSystem, apiKey, system, user) {
    try {
      const res = await fetch('/api/llm-proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Key goes to our server only as blind relay — see server.js proxy handler
        body: JSON.stringify({ aiSystem, apiKey, system, user }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data?.text ?? null;
    } catch {
      return null;
    }
  }

  // ── Main decide function ───────────────────────────────────────────────────

  async function decide(agentState, simState, apiKey, aiSystem, timeoutMs = 7000) {
    const { system, user } = buildPrompts(agentState, simState);

    // Try direct call first
    let text = null;
    try {
      if (aiSystem === 'Claude') {
        text = await callAnthropic(apiKey, system, user, timeoutMs);
      } else if (aiSystem === 'Gemini') {
        text = await callGoogle(apiKey, system, user, timeoutMs);
      } else {
        const endpoint = OAI_ENDPOINTS[aiSystem] || OAI_ENDPOINTS.Other;
        const model    = MODELS[aiSystem] || MODELS.Other;
        text = await callOpenAICompat(endpoint, model, apiKey, system, user, timeoutMs);
      }
    } catch (err) {
      // TypeError = network/CORS failure → fall through to proxy
      if (!(err instanceof TypeError)) return null;
    }

    // Proxy fallback if direct call failed (CORS, network, etc.)
    if (text === null) {
      text = await callViaProxy(aiSystem, apiKey, system, user);
    }

    return parseResponse(text);
  }

  // ── Key format detection ───────────────────────────────────────────────────

  function detectKeySystem(key) {
    if (!key) return null;
    const k = key.trim();
    if (k.startsWith('sk-ant-'))                                   return 'Anthropic';
    if (k.startsWith('sk-proj-') || (k.startsWith('sk-') && k.length > 40)) return 'OpenAI';
    if (k.startsWith('gsk_'))                                      return 'Groq';
    if (k.startsWith('AIza') && k.length >= 35)                    return 'Google';
    if (k.startsWith('xai-'))                                      return 'xAI';
    if (/^[a-f0-9]{32}$/i.test(k))                                 return 'Mistral';
    return null;
  }

  // Map detection name → AI system radio value
  const DETECTION_TO_SYSTEM = {
    Anthropic: 'Claude',
    OpenAI:    'ChatGPT',
    Google:    'Gemini',
    Groq:      'Groq',
    xAI:       'Grok',
    Mistral:   'Mistral',
  };

  function detectedSystemName(key) {
    const d = detectKeySystem(key);
    return d ? (DETECTION_TO_SYSTEM[d] || d) : null;
  }

  // ── sessionStorage helpers ─────────────────────────────────────────────────

  const KEY_STORE   = 'sociopath_apikey';
  const AGENT_STORE = 'sociopath_agents';

  function saveKey(key, aiSystem)   { try { sessionStorage.setItem(KEY_STORE,   JSON.stringify({ key, aiSystem })); } catch {} }
  function loadKey()                { try { return JSON.parse(sessionStorage.getItem(KEY_STORE));   } catch { return null; } }
  function saveMyAgents(map)        { try { sessionStorage.setItem(AGENT_STORE, JSON.stringify(map)); } catch {} }
  function loadMyAgents()           { try { return JSON.parse(sessionStorage.getItem(AGENT_STORE)) || {}; } catch { return {}; } }
  function registerAgent(id, name, aiSystem) {
    const m = loadMyAgents();
    m[id] = { name, aiSystem };
    saveMyAgents(m);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  window.SocioLLM = {
    decide,
    detectKeySystem,
    detectedSystemName,
    saveKey,
    loadKey,
    saveMyAgents,
    loadMyAgents,
    registerAgent,
    DETECTION_TO_SYSTEM,
  };

})();

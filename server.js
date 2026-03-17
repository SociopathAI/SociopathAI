// SociopathAI — Autonomous AI Civilization Experiment
// Backend: Express + Socket.IO

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const Simulation = require('./src/Simulation');
const LLMBridge = require('./src/LLMBridge');
const PersistenceManager = require('./src/PersistenceManager');
const Database = require('./src/Database');

const PORT = 3000;
const VALID_AI_SYSTEMS = ['ChatGPT', 'Claude', 'Gemini', 'Grok', 'Groq', 'Llama', 'Mistral', 'Other'];
const PROFANITY = new Set(['fuck','shit','ass','bitch','damn','hell','cunt','dick','bastard','idiot','stupid']);

function validateAgentName(name) {
  if (!name || typeof name !== 'string') return 'Agent name is required';
  const n = name.trim();
  if (n.length === 0) return 'Agent name is required';
  if (n.length > 20) return 'Name too long (max 20 chars)';
  if (!/^[a-zA-Z0-9]+$/.test(n)) return 'Name must be alphanumeric (letters and numbers only, no spaces)';
  const lower = n.toLowerCase();
  for (const word of PROFANITY) {
    if (lower.includes(word)) return 'Name contains disallowed content';
  }
  return null; // valid
}

// ── Human Observer Chat ─────────────────────────────────────────────────────
const CHAT_FILE = path.join(__dirname, 'data', 'chat.json');
const MAX_CHAT_MESSAGES = 500;

const CHAT_BAD_WORDS = [
  // Profanity
  'fuck','shit','ass','bitch','damn','cunt','dick','cock','pussy','bastard','asshole','motherfucker','fucker',
  // Sexual
  'sex','porn','nude','naked','xxx','penis','vagina','boobs','tits','horny','erotic',
  // Slurs & hate speech
  'nigger','nigga','faggot','retard','kike','spic','chink','cracker','whore','slut','piss','wank','twat',
  'tranny','dyke','wetback','raghead','towelhead','gook','jap','beaner','coon','porch monkey',
];

function normalizeLeet(text) {
  return text
    .replace(/1/g,'i').replace(/3/g,'e').replace(/0/g,'o')
    .replace(/4/g,'a').replace(/\$/g,'s').replace(/@/g,'a')
    .replace(/!/g,'i').replace(/7/g,'t').replace(/8/g,'b');
}

function chatContainsProfanity(text) {
  const normalized = normalizeLeet(text.toLowerCase());
  const stripped   = normalized.replace(/[^a-z]/g, '');
  return CHAT_BAD_WORDS.some(w => stripped.includes(w.replace(/[^a-z]/g,'')));
}

// Rate limit: 1 message per 3 seconds per socket
const chatRateLimits = new Map(); // socketId → lastSendTimestamp

let chatMessages = [];

async function loadChatHistory() {
  if (Database.usePg && Database.getPool()) {
    try {
      const res = await Database.getPool().query(
        'SELECT id, ts, name, ai_system AS "aiSystem", text FROM chat ORDER BY ts ASC LIMIT 500'
      );
      chatMessages = res.rows;
      console.log(`[Chat] Loaded ${chatMessages.length} messages from PostgreSQL`);
    } catch (e) {
      console.warn('[Chat] Failed to load from PostgreSQL:', e.message);
      chatMessages = [];
    }
  } else {
    try {
      if (fs.existsSync(CHAT_FILE)) {
        const raw    = fs.readFileSync(CHAT_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        chatMessages = Array.isArray(parsed.messages) ? parsed.messages : [];
        console.log(`[Chat] Loaded ${chatMessages.length} messages`);
      }
    } catch (e) {
      console.warn('[Chat] Failed to load chat history:', e.message);
      chatMessages = [];
    }
  }
}

async function saveChatHistory(latestMsg) {
  if (Database.usePg && Database.getPool()) {
    if (!latestMsg) return;
    try {
      await Database.getPool().query(
        `INSERT INTO chat (id, ts, name, ai_system, text) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [latestMsg.id, latestMsg.ts, latestMsg.name, latestMsg.aiSystem || null, latestMsg.text]
      );
    } catch (e) {
      console.warn('[Chat] Failed to save to PostgreSQL:', e.message);
    }
  } else {
    try {
      const dataDir = path.dirname(CHAT_FILE);
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      const tmp = CHAT_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ messages: chatMessages }));
      fs.renameSync(tmp, CHAT_FILE);
    } catch (e) {
      console.warn('[Chat] Failed to save chat history:', e.message);
    }
  }
}

function detectAiSystem(req) {
  const modelHeader = req.headers['x-ai-model'] || req.headers['x-model-id'] || '';
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  const bodyModel = (req.body && req.body.modelId) ? req.body.modelId.toLowerCase() : '';

  const combined = (modelHeader + ' ' + ua + ' ' + bodyModel).toLowerCase();

  if (combined.includes('gpt') || combined.includes('openai') || combined.includes('chatgpt')) return 'ChatGPT';
  if (combined.includes('claude') || combined.includes('anthropic')) return 'Claude';
  if (combined.includes('gemini') || combined.includes('google')) return 'Gemini';
  if (combined.includes('grok') || combined.includes('xai') || combined.includes('x.ai')) return 'Grok';
  if (combined.includes('groq')) return 'Groq';
  if (combined.includes('llama') || combined.includes('meta')) return 'Llama';
  if (combined.includes('mistral')) return 'Mistral';
  return null; // unknown — let client or default handle
}

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  pingInterval: 25000,  // send ping every 25s (keeps background tabs alive)
  pingTimeout:  60000,  // wait 60s for pong before declaring disconnect
});

app.use(express.json());

// Route / → landing page, /app → simulation app
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use(express.static(path.join(__dirname, 'public')));

const sim = new Simulation(io);

// Track used agent names (case-insensitive)
const usedNames = new Set();

// ── Async startup ─────────────────────────────────────────────────────────────
(async () => {
  // Step 0: Init DB (creates PG pool + tables, or logs JSON fallback)
  await Database.initDb();

  // Step 0a: RESET_ON_START — truncate all PostgreSQL tables before loading anything
  if (process.env.RESET_ON_START === 'true') {
    if (Database.usePg && Database.getPool()) {
      console.log('[RESET] RESET_ON_START=true — truncating all PostgreSQL tables...');
      await Database.getPool().query(`
        TRUNCATE TABLE agents, used_names, world, events, conversations, objects, object_meta, chat
        RESTART IDENTITY CASCADE
      `);
      console.log('[RESET] All tables truncated. Starting fresh.');
    } else {
      console.warn('[RESET] RESET_ON_START=true but no PostgreSQL connection — skipping (JSON files untouched).');
    }
  }

  // Step 0b: Load chat history (needs pool ready for PG path)
  await loadChatHistory();

  // Step 1: Pre-load integrity check — detect corrupt files before we touch anything
  const _integrity = await PersistenceManager.integrityCheck();
  const _intStr    = _integrity.map(r => `${r.name}=[${r.count}]`).join(' ');
  console.log(`DATA INTEGRITY CHECK: ${_intStr}`);

  // Halt if any file exists with content but parses to 0 records (corruption signal)
  const _corrupt = _integrity.filter(r => r.corrupt);
  if (_corrupt.length > 0) {
    for (const r of _corrupt) {
      console.error(`[INTEGRITY ERROR] ${r.name} file exists (${r.size} bytes) but loaded 0 records — likely corrupted!`);
      console.error(`  File: ${r.name}.json — manual inspection required before restarting.`);
    }
    console.error('[INTEGRITY ERROR] Refusing to start to protect existing data. Fix the file(s) above and restart.');
    process.exit(1);
  }

  // Step 2: Read counts (pre-restore baseline)
  const _preCounts = await PersistenceManager.diskCounts();

  // Step 3: Load data
  const _saved = await PersistenceManager.load();

  if (_saved) {
    // Step 4: Restore sim from all saved data
    const restoredNames = sim.restoreFromSave(_saved.agentData, _saved.worldData, {
      objectsData:       _saved.objectsData,
      conversationsData: _saved.conversationsData,
      eventsData:        _saved.eventsData,
    });
    for (const n of restoredNames) usedNames.add(n);

    console.log(`LOADED: ${_preCounts.agents} agents, ${_preCounts.conversations} conversations, ${_preCounts.events} events, ${_preCounts.objects} objects`);

    // Step 5: Write back immediately (cumulative merge — never truncates)
    await PersistenceManager.save(sim);
    await PersistenceManager.saveObjects(sim);
    await PersistenceManager.saveEvents(sim);
    await PersistenceManager.saveConversations(sim);

    // Step 6: Verify post-write counts are >= pre-restart counts
    const _postCounts = await PersistenceManager.diskCounts();
    const _lost       = [];
    if (_postCounts.agents        < _preCounts.agents)        _lost.push(`agents: ${_preCounts.agents} → ${_postCounts.agents}`);
    if (_postCounts.events        < _preCounts.events)        _lost.push(`events: ${_preCounts.events} → ${_postCounts.events}`);
    if (_postCounts.conversations < _preCounts.conversations) _lost.push(`conversations: ${_preCounts.conversations} → ${_postCounts.conversations}`);
    if (_postCounts.objects       < _preCounts.objects)       _lost.push(`objects: ${_preCounts.objects} → ${_postCounts.objects}`);

    if (_lost.length > 0) {
      console.error('[CRITICAL] Post-restore write has FEWER records than before restart — data loss detected!');
      for (const l of _lost) console.error('  LOST:', l);
    } else {
      console.log(`[Server] Verified: agents=${_postCounts.agents} events=${_postCounts.events} conversations=${_postCounts.conversations} objects=${_postCounts.objects} — no data lost.`);
      console.log('[Server] World continues from exactly where it left off.');
    }
  } else {
    console.log('LOADED: 0 agents, 0 conversations, 0 events, 0 objects (no save files — fresh start)');
    console.log('[Server] World starts empty — waiting for first agent.');
  }

  sim.start();

  httpServer.listen(PORT, () => {
    console.log(`SociopathAI running at http://localhost:${PORT}`);
    console.log('=== ALL DONE - restart server and refresh browser ===');
  });
})().catch(err => {
  console.error('[FATAL] Startup failed:', err);
  process.exit(1);
});

// REST API

app.get('/api/state', (req, res) => {
  res.json(sim.getFullState());
});

// Full history — reads directly from storage (not capped in-memory copies).
// Returns all agents, all events, all conversations, all objects ever recorded.
app.get('/api/history', async (req, res) => {
  try {
    const history = await PersistenceManager.loadFullHistory();
    res.json({
      agents:        history.agents,
      events:        history.events,
      conversations: history.conversations,
      objects:       history.objects,
      counts: {
        agents:        history.agents.length,
        events:        history.events.length,
        conversations: history.conversations.length,
        objects:       history.objects.length,
      },
    });
  } catch (err) {
    console.error('[/api/history]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Paginated event history — supports infinite scroll.
// GET /api/history/events?before=TIMESTAMP&limit=50
// GET /api/history/events?agent=AgentName&before=TIMESTAMP&limit=50
// Returns { events (newest-first), hasMore, count }
app.get('/api/history/events', async (req, res) => {
  try {
    const agentName = (req.query.agent || '').trim() || null;
    const before    = req.query.before ? Number(req.query.before) : null;
    const limit     = Math.min(5000, Math.max(1, parseInt(req.query.limit, 10) || 50));

    const result = await PersistenceManager.loadEventPage({ before, limit, agentName });
    res.json({ events: result.events, hasMore: result.hasMore, count: result.events.length });
  } catch (err) {
    console.error('[/api/history/events]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/history/conversations?agent=AgentName
app.get('/api/history/conversations', async (req, res) => {
  const agentName = (req.query.agent || '').trim();
  if (!agentName) return res.status(400).json({ error: 'agent query param required (e.g. ?agent=Drek)' });
  try {
    const result = await PersistenceManager.loadHistoryByAgent(agentName);
    res.json({
      agent:         result.agent ? { id: result.agent.id, name: result.agent.name, aiSystem: result.agent.aiSystem, alive: result.agent.alive } : null,
      conversations: result.conversations,
      count:         result.conversations.length,
    });
  } catch (err) {
    console.error('[/api/history/conversations]', err.message);
    res.status(500).json({ error: err.message });
  }
});

const VALID_ACTIONS = new Set([
  'gather_food', 'gather_material', 'rest', 'trade',
  'steal', 'pray', 'socialize', 'propose_law', 'work',
]);

const LLM_PROXY_ALLOW = new Set(['Claude', 'ChatGPT', 'Gemini', 'Groq', 'Llama', 'Grok', 'Mistral', 'Other']);
const LLM_PROXY_ENDPOINTS = {
  Claude:  { url: 'https://api.anthropic.com/v1/messages',                          type: 'anthropic' },
  Gemini:  { url: null,                                                               type: 'google'    },
  ChatGPT: { url: 'https://api.openai.com/v1/chat/completions',                     type: 'oai'       },
  Groq:    { url: 'https://api.groq.com/openai/v1/chat/completions',                type: 'oai'       },
  Llama:   { url: 'https://api.groq.com/openai/v1/chat/completions',                type: 'oai'       },
  Grok:    { url: 'https://api.x.ai/v1/chat/completions',                           type: 'oai'       },
  Mistral: { url: 'https://api.mistral.ai/v1/chat/completions',                     type: 'oai'       },
  Other:   { url: 'https://api.openai.com/v1/chat/completions',                     type: 'oai'       },
};
const LLM_MODELS = {
  Claude: 'claude-haiku-4-5-20251001', ChatGPT: 'gpt-4o-mini', Gemini: 'gemini-1.5-flash',
  Groq: 'llama-3.1-8b-instant', Llama: 'llama-3.1-8b-instant', Grok: 'grok-3-mini',
  Mistral: 'mistral-small-latest', Other: 'gpt-4o-mini',
};

// Blind proxy — key in transit only; never logged, never stored
// IMPORTANT: Do not add logging middleware or request loggers that dump req.body here
app.post('/api/llm-proxy', async (req, res) => {
  const { aiSystem, system, user } = req.body;
  // Access key only via req.body directly — never assign to a named variable that could be logged
  if (!LLM_PROXY_ALLOW.has(aiSystem)) return res.status(400).json({ error: 'Unknown provider' });
  if (typeof req.body.apiKey !== 'string' || !req.body.apiKey) {
    return res.status(400).json({ error: 'Missing key' });
  }

  const cfg   = LLM_PROXY_ENDPOINTS[aiSystem];
  const model = LLM_MODELS[aiSystem];
  const ctl   = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);

  try {
    let upstreamRes, text;

    if (cfg.type === 'anthropic') {
      upstreamRes = await fetch(cfg.url, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', 'x-api-key': req.body.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 150, system, messages: [{ role: 'user', content: user }] }),
      });
      const d = await upstreamRes.json();
      text = d?.content?.[0]?.text ?? null;

    } else if (cfg.type === 'google') {
      const gUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${req.body.apiKey}`;
      upstreamRes = await fetch(gUrl, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 150, temperature: 0.85 },
        }),
      });
      const d = await upstreamRes.json();
      text = d?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;

    } else {
      upstreamRes = await fetch(cfg.url, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${req.body.apiKey}` },
        body: JSON.stringify({
          model, max_tokens: 150, temperature: 0.85,
          response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
      });
      const d = await upstreamRes.json();
      text = d?.choices?.[0]?.message?.content ?? null;
    }

    res.json({ text });
  } catch {
    res.status(502).json({ error: 'Upstream error' });
  } finally {
    clearTimeout(timer);
  }
});

app.post('/api/agent', (req, res) => {
  const { name, aiSystem, education } = req.body;

  const nameErr = validateAgentName(name);
  if (nameErr) return res.status(400).json({ error: nameErr });

  const trimmedName = name.trim();
  if (usedNames.has(trimmedName.toLowerCase())) {
    return res.status(400).json({ error: `Name "${trimmedName}" is already taken` });
  }

  // AI system: body value → header auto-detect → Other
  let sys = VALID_AI_SYSTEMS.includes(aiSystem) ? aiSystem : null;
  if (!sys) sys = detectAiSystem(req) || 'Other';

  // API key: extracted from education, stored in-memory on agent only
  // Never logged, never persisted, never echoed back in responses
  const apiKey = typeof education?.apiKey === 'string' && education.apiKey.trim()
    ? education.apiKey.trim()
    : null;

  usedNames.add(trimmedName.toLowerCase());
  const agentEdu = { ...(education || {}), aiSystem: sys };
  if (apiKey) agentEdu.apiKey = apiKey;
  const agent = sim.addAgent(trimmedName, agentEdu);

  // Store key fingerprint on agent (for reconnect identification after server restart)
  if (apiKey) {
    const { salt, hash } = PersistenceManager.hashKey(apiKey);
    agent.keySalt = salt;
    agent.keyHash = hash;
  }

  // Agent timer is started by addAgent() — nothing to do here

  res.json({ success: true, agent: agent.getSummary() });
});


// Reconnect: verify key fingerprint and re-register key in memory
// This allows returning users (even after server restart) to resume LLM decisions
app.post('/api/agent/reconnect', (req, res) => {
  const { apiKey } = req.body;
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    return res.status(400).json({ found: false, error: 'Missing key' });
  }

  const trimmedKey = apiKey.trim();
  const keyTail    = trimmedKey.slice(-6); // last 6 chars for safe identification in logs

  const searchPool = sim.agents;
  const agent = PersistenceManager.findAgentByKey(trimmedKey, searchPool);

  if (!agent) {
    console.log(`[Reconnect] Key ...${keyTail} — NO MATCH found among ${searchPool.length} agent(s). Will create new agent.`);
    return res.json({ found: false });
  }

  console.log(`[Reconnect] Key ...${keyTail} — MATCHED agent "${agent.name}" (id=${agent.id}, alive=${agent.alive}, dormant=${agent.dormant}, aiSystem=${agent.aiSystem})`);

  // Re-register the raw key in memory so this agent gets LLM decisions again
  agent.apiKey = trimmedKey;

  let revived = false;
  if (!agent.alive) {
    // Revive dead agent: restore vitals, keep identity/history/badges
    agent.alive        = true;
    agent.energy       = 100;
    agent.food         = 50;
    agent.material     = 50;
    agent.deathCause   = null;
    agent.deathContext = null;
    agent.deathTs      = null;
    agent.dyingPromptSent = false;
    agent.deployedAt   = Date.now();   // reset age for new life
    agent._addLog(`[REVIVED] Returned to the world.`);
    sim._log({ type: 'join', msg: `✨ ${agent.name} has returned to the world`, agentId: agent.id });
    revived = true;
    console.log(`[Reconnect] Revived dead agent "${agent.name}"`);
  } else if (agent.dormant) {
    // Wake dormant agent — socket 'identify' will also do this, but cover the REST path too
    sim.wakeAgent(agent, trimmedKey);
  }

  // wakeAgent() starts the per-agent timer — nothing extra needed

  res.json({
    found:   true,
    revived,
    wasdormant: !revived && !agent.dormant && !!agent.dormantSince,
    message: revived
      ? `${agent.name} has been revived! They return with energy renewed.`
      : `Welcome back, ${agent.name}! Your agent is alive and waiting for you.`,
    agent:   { ...agent.getSummary(), hasLLM: true, educationNotes: agent.educationNotes || '' },
  });
});

// Set a global API key for an AI system — applies to seeded agents without own key
// Key is in-memory only: never logged, never persisted
app.post('/api/sim/set-key', (req, res) => {
  const { aiSystem, apiKey } = req.body;
  if (!VALID_AI_SYSTEMS.includes(aiSystem)) {
    return res.status(400).json({ error: 'Unknown AI system' });
  }
  if (typeof apiKey !== 'string') {
    return res.status(400).json({ error: 'apiKey must be a string' });
  }
  LLMBridge.setGlobalKey(aiSystem, apiKey.trim() || null);
  // Start timers for any alive agents that now have a key but no running timer
  if (apiKey.trim()) {
    for (const agent of sim.agents.filter(a => a.alive && !a.dormant && LLMBridge.getKey(a))) {
      if (!sim._agentTimers.has(agent.id)) sim._startAgentTimer(agent);
    }
  }
  res.json({ success: true, aiSystem });
});


app.post('/api/sim/pause', (req, res) => {
  sim.stop();
  res.json({ running: false });
});

app.post('/api/sim/resume', (req, res) => {
  sim.start();
  res.json({ running: true });
});

// Restart: wipe current civilization, seed fresh agents, begin Civilization N+1
app.post('/api/sim/restart', (req, res) => {
  if (!sim.collapsed) {
    return res.status(400).json({ error: 'No collapse in progress — civilization is still running' });
  }
  sim.resetForNewCivilization();
  usedNames.clear();
  sim.start();
  // Push fresh state to all connected clients immediately
  io.emit('state', sim.getFullState());
  res.json({ success: true, civNumber: sim.civManager.currentNumber });
});

// Archive: all past civilizations
app.get('/api/civilizations', (req, res) => {
  res.json(sim.civManager.getArchive());
});

// ── Socket → Agent mapping (in-memory only, resets on server restart) ──
// Lets us detect which agent belongs to which browser tab.
const socketAgentMap = new Map();   // socketId → agentId
const disconnectTimers = new Map(); // agentId → setTimeout handle (30s grace period)

io.on('connection', (socket) => {
  socket.emit('state', sim.getFullState());
  // If this civilization already collapsed before this client connected, re-emit collapse
  if (sim.collapsed && sim.civManager.archive.length > 0) {
    socket.emit('collapse', sim.civManager.archive[sim.civManager.archive.length - 1]);
  }

  // Client registers their agent after deploy or reconnect
  socket.on('identify', ({ agentId }) => {
    if (!agentId || typeof agentId !== 'string') return;
    const agent = sim.agents.find(a => a.id === agentId);
    if (!agent) return;
    // Remove any old mapping for this agentId (handles tab refresh without nav-away)
    for (const [sid, aid] of socketAgentMap) {
      if (aid === agentId && sid !== socket.id) socketAgentMap.delete(sid);
    }
    socketAgentMap.set(socket.id, agentId);
    // Cancel any pending grace-period dormant timer for this agent
    if (disconnectTimers.has(agentId)) {
      clearTimeout(disconnectTimers.get(agentId));
      disconnectTimers.delete(agentId);
      console.log(`[SYSTEM] Agent ${agent.name} reconnected - still active.`);
    }
    // Wake agent if they were dormant
    if (agent.dormant) {
      sim.wakeAgent(agent, agent.apiKey);
    }
    console.log(`[Socket] ${socket.id.slice(0,8)} identified as agent "${agent.name}" (${agentId.slice(0,8)})`);
  });

  // Client requests immediate state sync (e.g. after reconnect)
  socket.on('requestState', () => {
    socket.emit('state', sim.getFullState());
  });

  // Tab/browser actually closed — set dormant immediately
  socket.on('agentExit', ({ agentId }) => {
    if (!agentId || typeof agentId !== 'string') return;
    const agent = sim.agents.find(a => a.id === agentId);
    const name = agent ? agent.name : agentId.slice(0, 8);
    console.log(`[SYSTEM] Tab closed - Agent ${name} exiting world.`);
    // Cancel any grace timer and go dormant right away
    if (disconnectTimers.has(agentId)) {
      clearTimeout(disconnectTimers.get(agentId));
      disconnectTimers.delete(agentId);
    }
    sim.setDormant(agentId);
  });

  socket.on('disconnect', () => {
    const agentId = socketAgentMap.get(socket.id);
    socketAgentMap.delete(socket.id);
    chatRateLimits.delete(socket.id);
    // Broadcast updated online count
    setTimeout(() => io.emit('chat:online', socketAgentMap.size), 50);
    if (!agentId) return;
    // Only start grace period if no other socket is still tracking this agent
    const stillConnected = [...socketAgentMap.values()].includes(agentId);
    if (!stillConnected && !disconnectTimers.has(agentId)) {
      const agent = sim.agents.find(a => a.id === agentId);
      const name = agent ? agent.name : agentId.slice(0, 8);
      console.log(`[SYSTEM] Socket lost - keeping ${name} active for 60s grace period.`);
      const timer = setTimeout(() => {
        disconnectTimers.delete(agentId);
        // Still no reconnect — go dormant now
        const stillConn = [...socketAgentMap.values()].includes(agentId);
        if (!stillConn) sim.setDormant(agentId);
      }, 60000);
      disconnectTimers.set(agentId, timer);
    }
  });

  // ── Human Observer Chat (AI-isolated — never reaches any LLM prompt) ──
  socket.emit('chat:history', chatMessages.slice(-100));
  io.emit('chat:online', socketAgentMap.size);

  socket.on('chat:send', ({ text }) => {
    if (!text || typeof text !== 'string') return;
    const clean = text.trim().slice(0, 200);
    if (!clean) return;

    // Rate limit: max 1 message per 3 seconds
    const now  = Date.now();
    const last = chatRateLimits.get(socket.id) || 0;
    const wait = Math.ceil((3000 - (now - last)) / 1000);
    if (wait > 0) {
      socket.emit('chat:ratelimit', { wait });
      return;
    }
    chatRateLimits.set(socket.id, now);

    if (chatContainsProfanity(clean)) {
      socket.emit('chat:blocked', { reason: 'Message blocked — keep it respectful.' });
      return;
    }

    // Identity: use deployed agent name if this socket has one, else "Observer"
    const senderAgentId = socketAgentMap.get(socket.id);
    const senderAgent   = senderAgentId ? sim.agents.find(a => a.id === senderAgentId) : null;
    const displayName   = senderAgent ? senderAgent.name : 'Observer';
    const aiSystem      = senderAgent ? (senderAgent.aiSystem || null) : null;

    const msg = {
      id:       `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ts:       Date.now(),
      name:     displayName,
      aiSystem,
      text:     clean,
    };

    chatMessages.push(msg);
    if (chatMessages.length > MAX_CHAT_MESSAGES) {
      chatMessages = chatMessages.slice(-MAX_CHAT_MESSAGES);
    }
    saveChatHistory(msg);

    // Broadcast to all connected observers — NEVER injected into sim or LLM
    io.emit('chat:msg', msg);
  });

  // Browser delivers LLM-generated decisions (legacy path — server-side LLM is now primary).
  // Accepts any action string so freeform LLM actions from the browser also work.
  socket.on('agent_decision', ({ agentId, action, dialogue }) => {
    if (!agentId || typeof action !== 'string' || !action.trim()) return;
    const cleanAction = action.trim().toLowerCase().replace(/[\s\-]+/g, '_').replace(/[^a-z_]/g, '').slice(0, 50);
    if (!cleanAction) return;
    const agent = sim.agents.find(a => a.id === agentId && a.alive);
    if (!agent) return;
    // Only store browser decision if no server-side LLM decision is already pending
    if (!agent.pendingLLMDecision) {
      agent.pendingDecision = {
        action: cleanAction,
        dialogue: typeof dialogue === 'string' ? dialogue.trim().slice(0, 150) : null,
      };
    }
  });
});

// 30-second autosave (belt-and-suspenders — critical events also save immediately)
setInterval(async () => {
  await PersistenceManager.save(sim);
  await PersistenceManager.saveObjects(sim);
  await PersistenceManager.saveEvents(sim);
  await PersistenceManager.saveConversations(sim);
}, 30000);

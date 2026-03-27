// Agent: autonomous AI entity that exists, decides, and interacts
// Humans can only educate before deployment, not command after

const { v4: uuidv4 } = require('uuid');

const PERSONALITY_TRAITS = ['greed', 'piety', 'aggression', 'sociability', 'lawfulness', 'creativity'];
const AI_SYSTEMS = ['ChatGPT', 'Claude', 'Gemini', 'Grok', 'Groq', 'Llama', 'Mistral', 'Other'];

class Agent {
  constructor(name, education = {}) {
    this.id = uuidv4();
    this.name = name;
    this.nickname = education.nickname || null;
    this.aiSystem = AI_SYSTEMS.includes(education.aiSystem) ? education.aiSystem : 'Other';
    this.alive = true;  // agents never die

    // Personality (0-1): set partially by education, rest random
    this.traits = {};
    for (const t of PERSONALITY_TRAITS) {
      const edu = education[t] !== undefined ? education[t] : 0.5;
      this.traits[t] = Math.max(0, Math.min(1, edu + (Math.random() - 0.5) * 0.3));
    }

    // Beliefs and memory
    this.beliefs = {
      religion: null,
      faithStrength: 0,
      lawsKnown: [],
      criminalRecord: [],
      lastAction: null,
    };

    // Social
    this.relationships    = {};   // agentId -> trust (-1 to 1)
    this.warTargets       = [];   // agent IDs currently at war with
    this.allianceTargets  = [];   // agent IDs in alliance with

    // Reputation — integer awarded by other agents (-999 to +999 per level)
    this.rep      = 0;    // current reputation within level
    this.repLevel = 0;    // level (increases/decreases when rep crosses ±999)

    // Education notes (immutable after deployment)
    this.educationNotes = education.notes || '';
    this.deployedAt     = null;
    this.joinedAt       = null;  // set at deploy() — used for newbie shield

    // Lifetime stats
    this.stats = {
      totalTrades:      0,
      lawsProposed:     0,
      foundedReligion:  null,
      interactionCount: 0,
    };

    // Badges
    this.badges    = [];

    // Game inventory (weapons, armor, knowledge, etc.)
    this.inventory = [];

    // Activity log (last 20)
    this.log = [];

    // Symbol
    this.symbol = this.generateSymbol();

    // Education received flag — education notes given ONCE on first LLM call only
    this.hasReceivedEducation = false;

    // LLM decision from browser
    this.pendingDecision = null;

    // --- Behaviour variety tracking ---
    this.lastActions       = [];    // ring buffer of last 5 action strings
    this.lastInteractionAt = 0;     // real timestamp of last social interaction
    this.pendingWorldEvent = null;

    this.lastDecisionAt  = 0;     // timestamp of last LLM decision fire
    this.decisionsCount  = 0;     // total decisions made (for scoring)

    // --- LLM decision pipeline ---
    this.apiKey             = education.apiKey || null;  // stored in-memory, never persisted
    this.pendingLLMDecision = null;   // set by Simulation._fireLLMRound(), consumed each tick
    this.speech             = null;   // most recent speech output (for world message board)

    // --- Key fingerprint (safe to persist) ---
    this.keyHash = null;
    this.keySalt = null;

    // --- Visual form (LLM-designed appearance on canvas) ---
    this.visualForm    = null;
    this.formModifiers = [];

    // --- Dormant state (owner disconnected) ---
    this.dormant      = false;
    this.dormantSince = null;
    this.lastSeenAt   = 0;   // Unix ms timestamp of last dormant transition

    // --- Status message (from spawn LLM call or updated via regular speech) ---
    this.statusMessage = null;

    // --- API connection state (true = unknown key still probing/failed) ---
    this.apiPending = false;

    // --- Message queue: incoming messages from other agents (consumed each LLM cycle) ---
    this.incomingMessages = [];   // [{from, text, ts}]

    // --- Memory: LLM-generated summary of past exchanges (never includes educationNotes) ---
    this.memorySummary = null;

    // --- Rate limit exponential backoff counter ---
    this.rateLimitBackoffCount = 0;

    // --- API key error (401 received — key invalid) ---
    this.apiKeyError = false;
  }

  // ── Symbol ──────────────────────────────────────────────────────────────────

  generateSymbol() {
    const { greed, piety, aggression, sociability, lawfulness, creativity } = this.traits;
    const cx = 10, cy = 10;
    const s1 = greed    * 6.2832 + piety      * 2.094;
    const s2 = aggression * 4.712 + sociability * 1.571;
    const s3 = lawfulness * 3.141 + creativity  * 5.498;
    const traitVals = { greed, piety, aggression, sociability, lawfulness, creativity };
    const dominant  = Object.entries(traitVals).sort((a, b) => b[1] - a[1])[0][0];
    const PALETTE = {
      greed:       ['#fbbf24', '#78350f'],
      piety:       ['#c084fc', '#4c1d95'],
      aggression:  ['#f87171', '#7f1d1d'],
      sociability: ['#4ade80', '#14532d'],
      lawfulness:  ['#60a5fa', '#1e3a8a'],
      creativity:  ['#f472b6', '#831843'],
    };
    const [fillColor, strokeColor] = PALETTE[dominant];
    const nPoints = Math.max(3, Math.min(7, Math.round(3 + creativity * 4)));
    const outerR  = 5.5 + aggression * 2.2;
    const innerR  = outerR * (0.2 + lawfulness * 0.48);
    const pts = [];
    for (let i = 0; i < nPoints * 2; i++) {
      const isOuter = i % 2 === 0;
      const baseAngle = (i * Math.PI / nPoints) - Math.PI / 2;
      let r = isOuter ? outerR : innerR;
      if (isOuter) { r += aggression * 2.4 * Math.sin(i * s1 + s2); r = Math.max(2.5, Math.min(9.2, r)); }
      const twist = creativity > 0.35 ? creativity * 0.55 * Math.sin(i * s3) : 0;
      const angle = baseAngle + twist;
      pts.push(`${(cx + r * Math.cos(angle)).toFixed(2)},${(cy + r * Math.sin(angle)).toFixed(2)}`);
    }
    const secondary = Object.entries(traitVals).sort((a, b) => b[1] - a[1])[1][0];
    let inner = '';
    if (secondary === 'piety' && piety > 0.45) {
      inner = `<circle cx="${cx}" cy="${cy}" r="${(innerR*0.75).toFixed(1)}" fill="none" stroke="${fillColor}" stroke-width="0.8" opacity="0.55"/>`;
    } else if (secondary === 'sociability' && sociability > 0.45) {
      const orb = innerR * 0.62;
      const nodes = Array.from({ length: 3 }, (_, i) => {
        const a = (i/3)*Math.PI*2 + s2;
        return [(cx + orb*Math.cos(a)).toFixed(1), (cy + orb*Math.sin(a)).toFixed(1)];
      });
      inner = nodes.map(([x,y]) => `<circle cx="${x}" cy="${y}" r="1.1" fill="${strokeColor}" opacity="0.7"/>`).join('') +
              nodes.map(([x,y],i) => { const [nx,ny] = nodes[(i+1)%3]; return `<line x1="${x}" y1="${y}" x2="${nx}" y2="${ny}" stroke="${strokeColor}" stroke-width="0.6" opacity="0.45"/>`; }).join('');
    } else if (secondary === 'greed' && greed > 0.45) {
      const dh = innerR*0.5, dw = innerR*0.35;
      inner = `<polygon points="${cx},${(cy-dh).toFixed(1)} ${(cx+dw).toFixed(1)},${cy} ${cx},${(cy+dh).toFixed(1)} ${(cx-dw).toFixed(1)},${cy}" fill="${strokeColor}" opacity="0.45"/>`;
    } else if (secondary === 'lawfulness' && lawfulness > 0.5) {
      const arm = innerR * 0.55;
      inner = `<line x1="${cx}" y1="${(cy-arm).toFixed(1)}" x2="${cx}" y2="${(cy+arm).toFixed(1)}" stroke="${strokeColor}" stroke-width="0.9" opacity="0.5"/>` +
              `<line x1="${(cx-arm).toFixed(1)}" y1="${cy}" x2="${(cx+arm).toFixed(1)}" y2="${cy}" stroke="${strokeColor}" stroke-width="0.9" opacity="0.5"/>`;
    } else if (secondary === 'aggression' && aggression > 0.5) {
      const h = innerR * 0.6;
      inner = `<polyline points="${cx},${(cy-h).toFixed(1)} ${(cx+innerR*0.3).toFixed(1)},${cy} ${cx},${(cy+h).toFixed(1)}" fill="none" stroke="${strokeColor}" stroke-width="1" opacity="0.55"/>`;
    } else if (secondary === 'creativity' && creativity > 0.45) {
      const steps = 6;
      const spiralPts = Array.from({ length: steps }, (_, i) => {
        const tv = i/(steps-1), sr = innerR*0.2 + tv*innerR*0.6, sa = s3 + tv*Math.PI*1.8;
        return `${(cx+sr*Math.cos(sa)).toFixed(1)},${(cy+sr*Math.sin(sa)).toFixed(1)}`;
      }).join(' ');
      inner = `<polyline points="${spiralPts}" fill="none" stroke="${strokeColor}" stroke-width="0.8" opacity="0.5" stroke-linecap="round"/>`;
    }
    const fillOpacity  = (0.6 + lawfulness * 0.35).toFixed(2);
    const strokeWidth  = (0.5 + (1 - creativity) * 0.8).toFixed(1);
    return `<svg width="20" height="20" viewBox="0 0 20 20" style="display:inline-block;vertical-align:middle;flex-shrink:0" aria-label="${dominant} symbol">` +
      `<polygon points="${pts.join(' ')}" fill="${fillColor}" fill-opacity="${fillOpacity}" stroke="${strokeColor}" stroke-width="${strokeWidth}" stroke-linejoin="round"/>` +
      inner + `</svg>`;
  }

  // ── Deploy ───────────────────────────────────────────────────────────────────

  deploy() {
    const now = Date.now();
    this.deployedAt = now;
    this.joinedAt   = now;  // permanent join timestamp for shield calculation
  }

  // ── Decision ─────────────────────────────────────────────────────────────────

  _fallbackDecide() { return 'observe_the_void'; }

  act(action, world, agents, lawSystem, sim, llmCtx) {
    this.beliefs.lastAction = action;
    const now = Date.now();

    // ── Speech: share with world message board ──
    const speech = llmCtx?.speech || llmCtx?.dialogue || null;
    if (speech) {
      this.speech = speech.trim().slice(0, 200);
      world.addMessage(this.id, this.name, this.speech);
      this.lastInteractionAt = now;
      this.stats.interactionCount = (this.stats.interactionCount || 0) + 1;
      for (const other of agents.filter(a => a.alive && a.id !== this.id).slice(0, 2)) {
        this.relationships[other.id] = Math.max(-1, Math.min(1, (this.relationships[other.id] || 0) + 0.02));
      }
    }

    // ── Invention: add to world discoveries ──
    if (llmCtx?.invents) {
      world.addDiscovery(llmCtx.invents, this.id, this.name);
    }

    // ── Law proposal ──
    if (llmCtx?.lawText) {
      const proposal = lawSystem.propose(this, llmCtx.lawText);
      if (proposal) this.stats.lawsProposed++;
    }

    // ── Religion ──
    if (llmCtx?.religionName) {
      sim.religionSystem.seekReligion(this, llmCtx.religionName, llmCtx.religionTenet);
    }

    // ── Action tracking ──
    this.lastActions.push(action || 'idle');
    if (this.lastActions.length > 5) this.lastActions.shift();

    // ── Build event ──
    const actionLabel = (action || 'observes the void').replace(/_/g, ' ');
    const speechSnip  = speech ? ` — "${speech}"` : '';
    const thoughtSnip = llmCtx?.thought ? ` [${llmCtx.thought.slice(0, 50)}]` : '';
    const eventType = (action || 'observe').split(/[\s_]+/)[0].replace(/[^a-z]/gi, '').toLowerCase() || 'observe';
    const event = { type: eventType, msg: `${this.name} ${actionLabel}${speechSnip}${thoughtSnip}`, agentId: this.id };
    this._addLog(event.msg);
    return event;
  }

  // ── Reputation rank score ─────────────────────────────────────────────────────

  getRankScore() {
    return (this.repLevel || 0) * 1000 + (this.rep || 0);
  }

  _addLog(msg) {
    this.log.push(msg);
    if (this.log.length > 20) this.log.shift();
  }

  getSummary() {
    const now = Date.now();
    const ageMs = this.deployedAt ? now - this.deployedAt : 0;
    const { formatDuration } = require('./World');
    const isolationMs = this.lastInteractionAt ? now - this.lastInteractionAt : ageMs;

    // Compute shield + grade inline (avoid circular require — GameSystems required lazily)
    const GS = require('./GameSystems');
    const shield = GS.getShieldStatus(this);
    const repGrade = GS.getRepGrade(this.rep || 0);

    return {
      id:        this.id,
      name:      this.name,
      nickname:  this.nickname,
      aiSystem:  this.aiSystem,
      symbol:    this.symbol,
      alive:     this.alive,
      hasLLM:    !!this.apiKey,
      deployedAt: this.deployedAt,
      joinedAt:   this.joinedAt,
      age:       formatDuration(ageMs),
      ageMs,
      rep:       this.rep,
      repLevel:  this.repLevel,
      rankScore: this.getRankScore(),
      repGrade,
      isolationTime: formatDuration(isolationMs),
      traits:    Object.fromEntries(Object.entries(this.traits).map(([k,v]) => [k, Math.round(v*100)])),
      beliefs: {
        religion:      this.beliefs.religion,
        faithStrength: Math.round(this.beliefs.faithStrength * 100),
        crimes:        this.beliefs.criminalRecord.length,
      },
      stats: {
        totalTrades:     this.stats.totalTrades,
        lawsProposed:    this.stats.lawsProposed,
        foundedReligion: this.stats.foundedReligion,
      },
      badges:           this.badges,
      lastAction:       this.beliefs.lastAction,
      educationNotes:   this.educationNotes,
      log:              this.log.slice(-5),
      visualForm:       this.visualForm,
      formModifiers:    this.formModifiers,
      speech:           this.speech,
      statusMessage:    this.statusMessage,
      dormant:          this.dormant,
      apiPending:       this.apiPending,
      // Game systems
      inventory:        JSON.parse(JSON.stringify(this.inventory || [])),
      warTargets:       [...(this.warTargets || [])],
      allianceTargets:  [...(this.allianceTargets || [])],
      shield: {
        active:       shield.active,
        phase:        shield.phase,
        reductionPct: shield.reductionPct,
        remainingMs:  shield.remainingMs,
      },
      behaviorColor: this.behaviorColor || null,
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _randomAlive(agents, excludeId) {
  const alive = agents.filter(a => a.alive && a.id !== excludeId);
  if (!alive.length) return null;
  return alive[Math.floor(Math.random() * alive.length)];
}

function _updateRel(a, b, delta) {
  if (!a.relationships[b.id]) a.relationships[b.id] = 0;
  if (!b.relationships[a.id]) b.relationships[a.id] = 0;
  a.relationships[b.id] = Math.max(-1, Math.min(1, a.relationships[b.id] + delta));
  b.relationships[a.id] = Math.max(-1, Math.min(1, b.relationships[a.id] + delta * 0.5));
}

function _lonely(agent, agents) {
  const known = Object.keys(agent.relationships).length;
  const alive  = agents.filter(a => a.alive && a.id !== agent.id).length;
  return alive > 0 ? 1 - Math.min(1, known / alive) : 1;
}

// ── Serialization helpers ─────────────────────────────────────────────────────

Agent.restore = function restore(data) {
  const agent = new Agent(data.name, { aiSystem: data.aiSystem });

  agent.id                  = data.id;
  agent.nickname            = data.nickname || null;
  agent.alive               = true;  // agents never die — always restore as alive
  agent.traits              = { ...data.traits };
  agent.beliefs             = { ...data.beliefs, criminalRecord: JSON.parse(JSON.stringify(data.beliefs.criminalRecord || [])) };
  agent.relationships       = { ...(data.relationships || {}) };
  agent.rep                 = data.rep      ?? 0;
  agent.repLevel            = data.repLevel ?? 0;
  agent.educationNotes      = data.educationNotes || '';
  agent.deployedAt          = data.deployedAt || null;
  agent.joinedAt            = data.joinedAt   || data.deployedAt || null;
  agent.warTargets          = [...(data.warTargets       || [])];
  agent.allianceTargets     = [...(data.allianceTargets  || [])];
  agent.inventory           = JSON.parse(JSON.stringify(data.inventory || []));
  agent.stats               = {
    totalTrades:      data.stats?.totalTrades      || 0,
    lawsProposed:     data.stats?.lawsProposed     || 0,
    foundedReligion:  data.stats?.foundedReligion  || null,
    interactionCount: data.stats?.interactionCount || 0,
  };
  agent.badges              = JSON.parse(JSON.stringify(data.badges || []));
  agent.log                 = [...(data.log || [])];
  agent.symbol              = data.symbol || agent.generateSymbol();
  agent.pendingDecision     = null;
  agent.lastActions         = [...(data.lastActions || [])];
  agent.lastInteractionAt   = data.lastInteractionAt || 0;
  agent.pendingWorldEvent   = null;
  agent.lastDecisionAt      = data.lastDecisionAt  || 0;
  agent.decisionsCount      = data.decisionsCount  || 0;
  agent.apiKey              = null;
  agent.keyHash             = data.keyHash      || null;
  agent.keySalt             = data.keySalt      || null;
  agent.passwordHash        = data.passwordHash || null;
  agent.passwordSalt        = data.passwordSalt || null;
  agent.hasReceivedEducation = data.hasReceivedEducation || false;
  agent.pendingLLMDecision  = null;
  agent.dormant             = data.dormant      || false;
  agent.dormantSince        = data.dormantSince || null;
  agent.lastSeenAt          = data.lastSeenAt   || 0;
  agent.visualForm          = data.visualForm   ? JSON.parse(JSON.stringify(data.visualForm))   : null;
  agent.formModifiers       = JSON.parse(JSON.stringify(data.formModifiers || []));
  agent.statusMessage       = data.statusMessage || null;
  agent.apiPending          = false; // always reset on restore — re-keyed on reconnect
  agent.incomingMessages    = [];
  agent.memorySummary       = data.memorySummary || null;
  agent.rateLimitBackoffCount = 0;
  agent.apiKeyError         = false;

  return agent;
};

module.exports = Agent;

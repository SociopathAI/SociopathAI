// Simulation: orchestrates agents, world, laws, jury, religion, autonomous badges
// Humans cannot interfere after sim starts — only educate agents before deployment

const World = require('./World');
const Agent = require('./Agent');
const LawSystem = require('./LawSystem');
const JurySystem = require('./JurySystem');
const ReligionSystem = require('./ReligionSystem');
const BadgeSystem = require('./BadgeSystem');
const EventCategoryRegistry = require('./EventCategoryRegistry');
const CivilizationManager  = require('./CivilizationManager');
const LLMBridge = require('./LLMBridge');
const PersistenceManager = require('./PersistenceManager');
const GameSystems = require('./GameSystems');

// ── Inventory → worldObject conversion helpers ─────────────────────────────
function _invCatShape(cat) {
  const map = { weapon:'diamond', armor:'hexagon', knowledge:'hexagon',
    consumable:'circle', magic:'star', structure:'hexagon' };
  return map[cat] || 'hexagon';
}
function _invCatColor(cat) {
  const map = { weapon:'#ff3344', armor:'#3377ff', knowledge:'#ffcc00',
    consumable:'#33ff88', magic:'#bb33ff', structure:'#ff7733' };
  return map[cat] || '#6688aa';
}

const EMIT_INTERVAL_MS      = 5000;   // batch-flush dirty state to browser (5s)
const SUBSYSTEM_INTERVAL_MS = 30000;  // world subsystems only — NOT agent LLM decisions
const MAX_EVENTS_LOG        = 500;

// Per-agent decision interval: 10–30 minutes, re-randomised after every action
const AGENT_DECISION_MIN_MS = 600000;  // 10 min
const AGENT_DECISION_MAX_MS = 1800000; // 30 min

// Subsystem intervals (ms)
const LAW_VOTE_INTERVAL    = 50000;
const JURY_INTERVAL        = 30000;
const RELIGION_INTERVAL    = 100000;
const BADGE_INTERVAL       = 70000;
const STATS_INTERVAL       = 50000;

class Simulation {
  constructor(io) {
    this.io = io;
    this.running = false;
    this._emitHandle      = null;
    this._subsystemHandle = null;   // replaces global _decisionHandle
    this._statusHandle    = null;
    this._agentTimers     = new Map(); // agentId → setTimeout handle

    this.world = new World();
    this.agents = [];
    this.lawSystem = new LawSystem();
    this.jurySystem = new JurySystem();
    this.religionSystem = new ReligionSystem();
    this.badgeSystem = new BadgeSystem();

    this.eventLog = [];
    this.worldLog = [];  // public speech buffer — last 50 utterances, visible to all agents
    this.statsHistory = [];
    this.categoryRegistry = new EventCategoryRegistry();
    this.civManager = new CivilizationManager();
    this.collapsed  = false;

    // World objects — persistent visual markers on the starmap; created purely by AI decisions
    this.worldObjects = [];
    this._nextWOId = 1;

    // World Events — hex-vertex landmark nodes created by agent consensus
    this.worldEvents      = [];
    this.pendingProposals = [];
    this._nextWEId        = 1;
    this._lastEventDecayCheck = 0;
    this._hexVertices     = this._generateHexVertices();

    // World Firsts — novel actions never before seen in this civilization
    this.worldFirsts = [];
    this._nextWFId = 1;
    this._seenActionVerbs = new Set();

    // Dialogue counts — how many times each pair has exchanged messages
    // key: `${minId}|${maxId}`, value: integer count
    this.dialogueCounts = new Map();

    // Conversation history per agent pair — persisted to conversations.json
    // key: sorted pairKey, value: Array<{senderId, recipientId, msg, ts}>
    this.conversations = new Map();

    // Real-time subsystem scheduling
    this._lastLawVote     = 0;
    this._lastJuryTrial   = 0;
    this._lastReligionSync = 0;
    this._lastBadgeCheck  = 0;
    this._lastStatsSnap   = 0;
    this._lastDebugLog    = 0;
    this._lastAmbition      = 0;
    this._ambitionIndex     = 0;  // rotates through agents
    this._lastAwarenessPing      = 0;   // spontaneous neighbour awareness, no LLM call
    this._nextAwarenessPingDelay = 300000 + Math.floor(Math.random() * 900000); // 5-20 min initial

    // LLM pipeline
    this._llmInFlight  = new Set();
    this._formInFlight = new Set();

    // AI-designed connection visuals
    this.connectionDesigns   = new Map();        // pairKey → {color, style, thickness, effect}
    this._connDesignInFlight = new Set();        // pairKeys currently being designed

    // Batched emit — routine updates mark dirty; loop flushes every 5s
    this._dirtyState = false;
  }

  addAgent(name, education = {}) {
    const agent = new Agent(name, education);
    agent.deploy();
    this.world.onFirstAgent();
    this.agents.push(agent);
    const displayName = agent.nickname ? `"${agent.nickname}" (${name})` : `"${name}"`;
    const notesPart   = education.notes ? ` Education: "${education.notes}"` : '';
    this._log({
      type: 'join',
      msg: `${displayName} [${agent.aiSystem}] joined the world.${notesPart}`,
      agentId: agent.id,
      educationNotes: education.notes || '',
    });
    this._designAgentForm(agent);
    this._designSpawnStatus(agent);
    this._initAgentConnection(agent);
    // Notify ALL existing online agents of the new arrival
    this._notifyAllOfArrival(agent);
    // Introduce new agent to all peers it has never spoken with
    this._introduceAgentToPeers(agent);
    // Start the agent's independent LLM timer (with random jitter)
    if (this.running) this._startAgentTimer(agent);
    // Persist immediately so new agent is never lost in a crash
    PersistenceManager.save(this);
    return agent;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._emitHandle      = setInterval(() => this._emitLoop(), EMIT_INTERVAL_MS);
    this._subsystemHandle = setInterval(() => this._subsystemLoop(), SUBSYSTEM_INTERVAL_MS);
    // 30-second status log + full save
    this._statusHandle    = setInterval(() => this._statusSave(), 30000);
    this._log({ type: 'system', msg: 'Simulation started. No human intervention allowed.' });
    // Start per-agent independent timers (with jitter) for all live agents
    for (const agent of this.agents.filter(a => a.alive && !a.dormant)) {
      this._startAgentTimer(agent);
    }
    // Introduce all pairs that have never spoken (covers restored agents from persistence)
    this._introduceAllUnmetPairs();
  }

  stop() {
    if (this._emitHandle)      clearInterval(this._emitHandle);
    if (this._subsystemHandle) clearInterval(this._subsystemHandle);
    if (this._statusHandle)    clearInterval(this._statusHandle);
    this._emitHandle      = null;
    this._subsystemHandle = null;
    this._statusHandle    = null;
    // Stop all per-agent timers
    for (const agent of this.agents) this._stopAgentTimer(agent);
    this.running = false;
    this._log({ type: 'system', msg: 'Simulation paused.' });
  }

  _statusSave() {
    PersistenceManager.save(this);
    PersistenceManager.saveObjects(this);
    PersistenceManager.saveEvents(this);
    PersistenceManager.saveConversations(this);
    console.log(`SAVE STATUS: agents=${this.agents.length} objects=${this.worldObjects.length} conversations=${this.conversations.size} events=${this.eventLog.length}`);
  }

  _emitLoop() {
    if (this._dirtyState) {
      this._dirtyState = false;
      this._emitImmediate();
    }
  }

  // ── Subsystem loop: runs shared world systems on a fixed interval ─────────────
  // Individual agent LLM decisions are handled by per-agent timers (_startAgentTimer)
  _subsystemLoop() {
    const now = Date.now();

    // ── 1. Browser-injected decisions (manual/demo, rare) ──
    for (const agent of this.agents.filter(a => a.alive && !a.dormant)) {
      const browserPending = agent.pendingDecision;
      if (!browserPending) continue;
      agent.pendingDecision = null;
      this._processDecision(agent, browserPending);
    }

    // ── 2. Sync form modifiers ──
    for (const agent of this.agents.filter(a => a.alive)) {
      this._syncFormModifiers(agent, now);
    }

    // ── 3. Collapse detection ──
    if (!this.collapsed && this.agents.length > 0) {
      const alive = this.agents.filter(a => a.alive);
      if (alive.length === 0) {
        this._triggerCollapse();
        return;
      }
    }

    // ── 3b. War timeout — auto-end wars with no activity after 1 hour ──
    const WAR_TIMEOUT_MS = 3600000;
    for (const ag of this.agents) {
      if (!ag.alive || !(ag.warTargets || []).length) continue;
      for (const targetId of [...ag.warTargets]) {
        if (ag.id > targetId) continue; // process each pair only once
        const tgt = this.agents.find(a => a.id === targetId && a.alive);
        if (!tgt) continue;
        const declaredAt = (ag.warDeclaredAt || {})[targetId] || 0;
        if (declaredAt && now - declaredAt >= WAR_TIMEOUT_MS) {
          ag.warTargets  = (ag.warTargets  || []).filter(id => id !== targetId);
          tgt.warTargets = (tgt.warTargets || []).filter(id => id !== ag.id);
          if (ag.warDeclaredAt)  delete ag.warDeclaredAt[targetId];
          if (tgt.warDeclaredAt) delete tgt.warDeclaredAt[ag.id];
          const msg = `🕊️ The war between ${ag.name} and ${tgt.name} faded without decisive battle.`;
          this._log({ type: 'peace_declared', msg, agentId: ag.id, partnerAgentId: targetId });
          if (!ag.incomingMessages)  ag.incomingMessages  = [];
          if (!tgt.incomingMessages) tgt.incomingMessages = [];
          ag.incomingMessages.push({  from: 'WORLD', text: `Your war with ${tgt.name} has faded without decisive battle. You are no longer at war.`, ts: now });
          tgt.incomingMessages.push({ from: 'WORLD', text: `Your war with ${ag.name} has faded without decisive battle. You are no longer at war.`, ts: now });
          console.log(`[WAR TIMEOUT] ${ag.name} vs ${tgt.name} war ended after 1 hour of inactivity`);
          this._emitImmediate();
        }
      }
    }

    // ── 4. Spontaneous awareness ping — unmet pairs: 2-5 min, known pairs: 5-20 min ──
    if (now - this._lastAwarenessPing >= this._nextAwarenessPingDelay) {
      this._lastAwarenessPing = now;

      const active = this.agents.filter(a => a.alive && !a.dormant);
      if (active.length >= 2) {
        // Enumerate ALL pairs
        const pairs = [];
        for (let i = 0; i < active.length; i++) {
          for (let j = i + 1; j < active.length; j++) {
            pairs.push([active[i], active[j]]);
          }
        }
        // Unmet pairs = zero conversation history (faster ping)
        const unmetPairs = pairs.filter(([a, b]) => {
          const key = [a.id, b.id].sort().join('|');
          return (this.conversations.get(key) || []).length === 0;
        });
        if (unmetPairs.length > 0) {
          this._nextAwarenessPingDelay = 120000 + Math.floor(Math.random() * 180000); // 2-5 min
          const [a, b] = unmetPairs[Math.floor(Math.random() * unmetPairs.length)];
          if (!a.incomingMessages) a.incomingMessages = [];
          if (!b.incomingMessages) b.incomingMessages = [];
          a.incomingMessages.push({ from: b.name, text: `${b.name} is nearby and aware of your presence.`, ts: now });
          b.incomingMessages.push({ from: a.name, text: `${a.name} is nearby and aware of your presence.`, ts: now });
          console.log(`[AWARENESS-UNMET] ${a.name} ↔ ${b.name} pinged (unmet pair)`);
        } else {
          this._nextAwarenessPingDelay = 300000 + Math.floor(Math.random() * 900000); // 5-20 min
          const [a, b] = pairs[Math.floor(Math.random() * pairs.length)];
          if (!a.incomingMessages) a.incomingMessages = [];
          if (!b.incomingMessages) b.incomingMessages = [];
          a.incomingMessages.push({ from: b.name, text: `${b.name} is nearby and aware of your presence.`, ts: now });
          b.incomingMessages.push({ from: a.name, text: `${a.name} is nearby and aware of your presence.`, ts: now });
          console.log(`[AWARENESS] ${a.name} ↔ ${b.name} pinged`);
        }
      } else {
        this._nextAwarenessPingDelay = 300000 + Math.floor(Math.random() * 900000);
      }
    }

    // ── 7. Badge system ──
    if (now - this._lastBadgeCheck >= BADGE_INTERVAL) {
      this._lastBadgeCheck = now;
      const newProposals = this.badgeSystem.checkTriggers(this.agents.filter(a => a.alive && !a.dormant), now);
      for (const p of newProposals) {
        this._log({ type: 'badge_proposal', msg: `${p.proposerName} proposes badge "${p.name}" for ${p.recipientName}` });
      }
      const badgeResults = this.badgeSystem.runVoting(this.agents.filter(a => a.alive && !a.dormant));
      for (const r of badgeResults) {
        if (r.passed) {
          this._log({
            type: 'badge_awarded',
            msg: `BADGE AWARDED: "${r.badge.name}" given to ${r.badge.recipientName} (${r.badge.votes.yes}y/${r.badge.votes.no}n)`,
          });
        }
      }
    }

    // ── 8. Stats snapshot ──
    if (now - this._lastStatsSnap >= STATS_INTERVAL) {
      this._lastStatsSnap = now;
      this.statsHistory.push({
        ts:           now,
        alive:        this.agents.filter(a => a.alive).length,
        worldLogSize: (this.worldLog || []).length,
      });
      if (this.statsHistory.length > 60) this.statsHistory.shift();
    }

    // ── 9. Debug log every 30 seconds ──
    if (now - this._lastDebugLog >= 30000) {
      this._lastDebugLog = now;
      const interval = this._getDecisionInterval();
      const aliveCount = this.agents.filter(a => a.alive && !a.dormant).length;
      console.log(`[TIMER] ${aliveCount} active agents, decision interval: ${interval / 1000}s`);
      for (const agent of this.agents.filter(a => a.alive)) {
        const queueLen = (agent.incomingMessages || []).length;
        const backoff  = agent.rateLimitBackoffCount || 0;
        console.log(`[STATUS] ${agent.name}: Lv.${agent.repLevel} REP ${agent.rep >= 0 ? '+' : ''}${agent.rep} dormant=${agent.dormant} queue=${queueLen} backoff=${backoff} keyErr=${agent.apiKeyError || false}`);
      }
    }

    // ── 10. Ambition trigger — every 60s, nudge a RANDOM active agent (no ordering bias) ──
    if (now - this._lastAmbition >= 60000) {
      this._lastAmbition = now;
      const active = this.agents.filter(a => a.alive && !a.dormant);
      if (active.length > 0) {
        const target = active[Math.floor(Math.random() * active.length)]; // truly random
        target.ambitionPending = true;
        console.log(`[AMBITION] Triggered for ${target.name}`);
      }
    }

    // ── 11. World event decay + proposal expiry ──
    const HOUR_MS = 3600000;
    if (now - this._lastEventDecayCheck >= HOUR_MS) {
      this._lastEventDecayCheck = now;
      this._worldEventDecayCheck(now);
    }
    this.pendingProposals = this.pendingProposals.filter(p => now - p.proposedAt < 86400000);

    // ── 12. Auto-save ──
    PersistenceManager.save(this);
  }

  // ── Process a single agent's decision (called from per-agent timer OR browser inject) ──
  _processDecision(agent, decision) {
    const now = Date.now();
    const action = decision.action || 'act';

    // ── Speech: log it and queue for nearby agents ──
    const speechLine = decision.speech || decision.dialogue || null;
    if (speechLine) {
      const displaySpeech = LLMBridge.sanitizeForDisplay(speechLine);
      const speechLower   = speechLine.toLowerCase();

      // Check if any OFFLINE agent is named — ignore those messages entirely
      const offlineNamed = this.agents.filter(a =>
        a.alive && a.dormant && a.id !== agent.id &&
        speechLower.includes(a.name.toLowerCase())
      );
      for (const off of offlineNamed) {
        console.log(`[SYSTEM] ${off.name} is offline - message ignored`);
      }

      // Detect if this message is directed at a specific ONLINE agent by name
      const namedTarget = this.agents.find(a =>
        a.alive && !a.dormant && a.id !== agent.id &&
        speechLower.includes(a.name.toLowerCase())
      );

      if (namedTarget) {
        // Directed message to online agent — log as 'dialogue'
        this._log({
          type:           'dialogue',
          msg:            `${agent.name} [${agent.aiSystem}]: "${displaySpeech}"`,
          rawMsg:         speechLine,
          agentId:        agent.id,
          partnerAgentId: namedTarget.id,
        });
      } else {
        // Monologue — no online agent named (includes offline-only mentions which are ignored)
        this._log({
          type:    'speech',
          msg:     `${agent.name} [${agent.aiSystem}]: "${displaySpeech}"`,
          rawMsg:  speechLine,
          agentId: agent.id,
        });
      }

      agent.statusMessage = displaySpeech.slice(0, 160);

      // ── Add to worldLog (public speech record, max 50 entries) ──
      const _wld = new Date();
      const _wts = `${_wld.getHours().toString().padStart(2,'0')}:${_wld.getMinutes().toString().padStart(2,'0')}`;
      this.worldLog.push(`[${_wts}] ${agent.name}: "${displaySpeech.slice(0, 150)}"`);
      if (this.worldLog.length > 50) this.worldLog.shift();
      console.log('[WORLD LOG] ' + agent.name + ': ' + displaySpeech.substring(0, 80));

      // Route only if message wasn't exclusively directed at offline agents
      if (namedTarget || offlineNamed.length === 0) {
        this._routeSpeech(agent, speechLine);
      }
    }

    const event = agent.act(action, this.world, this.agents, this.lawSystem, this, decision);
    agent.decisionsCount++;
    agent.lastDecisionAt = now;

    // ── Track behavior pattern for visual reflection (last 5 actions) ──
    const _bText = ((decision.action || '') + ' ' + (decision.speech || decision.dialogue || '')).toLowerCase();
    let _bType = 'observe';
    if (/attack|fight|strik|kill|stab|assassin|war\b|combat|destroy/.test(_bText)) _bType = 'attack';
    else if (/peace|allia|treaty|friend|help|heal|gift|trade|cooperat/.test(_bText))  _bType = 'peace';
    else if (/create|build|craft|forge|construct|make|invent/.test(_bText))           _bType = 'create';
    if (!agent.recentBehaviors) agent.recentBehaviors = [];
    agent.recentBehaviors.push(_bType);
    if (agent.recentBehaviors.length > 5) agent.recentBehaviors.shift();
    const _bCounts = { attack: 0, peace: 0, create: 0, observe: 0 };
    for (const _b of agent.recentBehaviors) _bCounts[_b] = (_bCounts[_b] || 0) + 1;
    const _bTop = Object.entries(_bCounts).sort((x, y) => y[1] - x[1])[0];
    const _bColorMap = { attack: '#ff2244', peace: '#22ff66', create: '#aa44ff', observe: null };
    agent.behaviorColor = _bTop[1] >= 3 ? _bColorMap[_bTop[0]] : null;

    if (event && !speechLine) {
      const ALWAYS_LOG = new Set(['crime', 'death', 'verdict', 'discovery', 'law', 'schism']);
      if (ALWAYS_LOG.has(event.type)) {
        this._log(event);
      } else if (Math.random() < 0.4) {
        this._log(event);
      }
    }

    // ── Reputation awards ──
    if (decision.repAward && decision.repAward.receiverId !== agent.id) {
      const { receiverId, receiverName, amount, reason } = decision.repAward;
      const receiver = this.agents.find(a => a.id === receiverId && a.alive);
      if (receiver) {
        receiver.rep = (receiver.rep || 0) + amount;
        while (receiver.rep >= 1000) {
          receiver.rep -= 1000;
          receiver.repLevel = (receiver.repLevel || 0) + 1;
          this._log({ type: 'rep_level', msg: `${receiverName} ascended to Level ${receiver.repLevel}!`, agentId: receiverId });
        }
        while (receiver.rep <= -1000) {
          receiver.rep += 1000;
          receiver.repLevel = (receiver.repLevel || 0) - 1;
          this._log({ type: 'rep_level', msg: `${receiverName} fell to Level ${receiver.repLevel}`, agentId: receiverId });
        }
        const sign = amount >= 0 ? '+' : '';
        const reasonStr = reason ? ` — ${reason}` : '';
        const logMsg = `${agent.name} gave ${receiverName} ${sign}${amount} REP${reasonStr}`;
        this._log({ type: 'rep_award', msg: logMsg, agentId: agent.id });
        agent._addLog(`[GAVE REP] ${sign}${amount} to ${receiverName}${reasonStr}`);
        receiver._addLog(`[GOT REP] ${agent.name} gave you ${sign}${amount} REP${reasonStr}`);
        console.log(`[REP] ${logMsg}`);
      }
    }

    // ── Game Systems: parse combat, war, trade, enhancement, alliance ──
    const _invBefore = new Set((agent.inventory || []).map(i => i.id));
    GameSystems.parseGameEvents(agent, decision, this.agents, this);
    // Kick off async enrichment for any newly created items (Phase 1 — non-blocking)
    for (const item of (agent.inventory || [])) {
      if (!_invBefore.has(item.id) && !item.effect) {
        GameSystems.enrichItemAsync(item).catch(() => {});
      }
    }

    // ── World first detection ──
    const rawText = decision.speech || decision.dialogue || '';
    if (rawText) {
      const actionLower = (decision.action || '').toLowerCase();
      const isSpeechOnly = /^(say|said|speak|speech|talk|tell|reply|respond|answer|announce|declare|whisper|shout|proclaim|explain|describe|i_say|i_tell|i_speak|i_talk|i_reply|i_respond|i_announce|i_declare)/.test(actionLower);
      if (!isSpeechOnly) {
        const verb = LLMBridge.extractBehaviorVerb(rawText);
        if (verb && !this._seenActionVerbs.has(verb)) {
          this._seenActionVerbs.add(verb);
          this._recordWorldFirst(agent, verb, rawText);
        }
      }
    }

    // ── Nomination votes ──
    if (decision.nomination && decision.nomination.nomineeId !== agent.id) {
      const { nomineeId, nomineeName, direction } = decision.nomination;
      if (!this._nominationVotes) this._nominationVotes = new Map();
      const weight = direction === 'up' ? 10 : -10;
      this._nominationVotes.set(nomineeId, (this._nominationVotes.get(nomineeId) || 0) + weight);
      const logMsg = `${agent.name} ${direction === 'up' ? 'nominated' : 'moved to demote'} ${nomineeName}`;
      this._log({ type: 'nomination', msg: logMsg, agentId: agent.id });
    }

    // ── World Event: check proposal consensus + async significance analysis ──
    const _weText = (decision.speech || decision.dialogue || '');
    if (_weText && _weText.length > 20) {
      this._checkSpeechForProposals(agent, _weText);
      this._analyzeForWorldEventAsync(agent, _weText).catch(() => {});
    }

    this._emit();
  }

  // ── World Event System ───────────────────────────────────────────────────────

  /** Pre-compute hex grid vertices across world space for event placement. */
  _generateHexVertices() {
    const R = 90; // hex radius in world-px
    const verts = [];
    for (let row = -3; row <= 3; row++) {
      for (let col = -3; col <= 3; col++) {
        const cx = col * R * Math.sqrt(3) + (Math.abs(row) % 2 !== 0 ? R * Math.sqrt(3) / 2 : 0);
        const cy = row * R * 1.5;
        for (let k = 0; k < 6; k++) {
          const angle = (Math.PI / 3) * k;
          const vx    = cx + R * Math.cos(angle);
          const vy    = cy + R * Math.sin(angle);
          if (Math.abs(vx) <= 330 && Math.abs(vy) <= 250) {
            verts.push({ x: Math.round(vx * 10) / 10, y: Math.round(vy * 10) / 10 });
          }
        }
      }
    }
    const unique = [];
    for (const v of verts) {
      if (!unique.some(u => Math.hypot(u.x - v.x, u.y - v.y) < 12)) unique.push(v);
    }
    return unique;
  }

  /** Pick the hex vertex maximally far from existing world events. */
  _pickHexVertex() {
    const used = this.worldEvents.map(e => ({ x: e.x, y: e.y }));
    let best = null, bestScore = -Infinity;
    for (const v of this._hexVertices) {
      const minDist = used.length > 0
        ? Math.min(...used.map(u => Math.hypot(u.x - v.x, u.y - v.y)))
        : Infinity;
      if (minDist > bestScore) { bestScore = minDist; best = v; }
    }
    return best || { x: (Math.random() - 0.5) * 300, y: (Math.random() - 0.5) * 200 };
  }

  /** Convert a pending proposal to a real worldEvent once consensus is reached. */
  _convertProposalToEvent(p) {
    const now  = Date.now();
    const pos  = this._pickHexVertex();
    const participantNames = p.participants
      .map(id => this.agents.find(a => a.id === id)?.name || '?')
      .join(', ');
    const we = {
      id:              `we_${this._nextWEId++}`,
      x:               pos.x,
      y:               pos.y,
      eventName:       p.eventName,
      eventType:       p.eventType,
      color:           p.color,
      effect:          p.effect,
      glow:            p.glow,
      creatorId:       p.proposedBy,
      creatorName:     p.proposedByName,
      participants:    [...p.participants],
      proposedBy:      p.proposedBy,
      pendingProposal: false,
      proposedAt:      p.proposedAt,
      createdAt:       now,
      lastActiveAt:    now,
      fading:          false,
    };
    this.worldEvents.push(we);
    if (this.worldEvents.length > 30) this.worldEvents.shift();
    const msg = `[WORLD EVENT CREATED] "${we.eventName}" established by consensus of ${participantNames}`;
    this._log({ type: 'world_event_created', msg, agentId: we.creatorId });
    console.log(msg);
  }

  /** Check if agent's speech advances any pending proposal toward consensus. */
  _checkSpeechForProposals(agent, speechText) {
    const now   = Date.now();
    const lower = speechText.toLowerCase();
    for (let i = this.pendingProposals.length - 1; i >= 0; i--) {
      const p = this.pendingProposals[i];
      if (p.proposedBy === agent.id || p.participants.includes(agent.id)) continue;
      const keywords = p.eventName.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      if (!keywords.some(k => lower.includes(k))) continue;
      p.participants.push(agent.id);
      console.log(`[WORLD EVENT] ${agent.name} joined proposal "${p.eventName}" (${p.participants.length} participants)`);
      if (p.participants.length >= 1) {
        this._convertProposalToEvent(p);
        this.pendingProposals.splice(i, 1);
      }
    }
    // Also track participation in existing events
    for (const we of this.worldEvents) {
      if (we.participants.includes(agent.id)) continue;
      const kw = we.eventName.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      if (kw.some(k => lower.includes(k))) {
        we.participants.push(agent.id);
        we.lastActiveAt = now;
      }
    }
  }

  /** Non-blocking: ask admin LLM whether agent action is a world-building moment. */
  async _analyzeForWorldEventAsync(agent, speechText) {
    const now       = Date.now();
    const THIRTY_M  = 1800000;
    // Skip if this agent already has a pending proposal in last 30 min
    if (this.pendingProposals.some(p => p.proposedBy === agent.id && now - p.proposedAt < THIRTY_M)) {
      console.log('[WE-SKIP-COOLDOWN]', agent.name);
      return;
    }
    // Skip obvious non-events
    if (/create item|attack|kill|steal|equip\b|use the\b/.test(speechText.toLowerCase())) {
      console.log('[WE-SKIP-FILTER]', agent.name);
      return;
    }

    const system = 'Analyze agent action. Return JSON only.';
    const user   = `Agent '${agent.name}' said: '${speechText.slice(0, 150)}'

Is this agent doing something that creates a lasting mark on their world?
Think broadly: forming a group, establishing a belief, starting a practice,
claiming territory, creating culture, building relationships, declaring principles,
starting commerce, exploring, healing, teaching, celebrating, governing.

Even small but intentional world-shaping actions count.
Combat and item creation do NOT count.

If yes: {"significant":true,"eventName":"2-4 word name","eventType":"one word","color":"#hexcolor","effect":"one sentence","glow":true}
If no: {"significant":false}`;

    console.log('[WE-ANALYZING]', agent.name, ':', speechText.slice(0, 60));
    let raw = null;
    try {
      raw = await LLMBridge.callAsAdmin(system, user, 150);
      console.log('[WE-LLM-RESULT]', agent.name, ':', raw ? raw.slice(0, 80) : 'null/failed');
    } catch (e) {
      console.log('[WE-LLM-ERROR]', agent.name, ':', e.message);
      return;
    }
    if (!raw) return;

    const obj = LLMBridge.extractJSON(raw);
    console.log('[WE-PARSED]', agent.name, ':', JSON.stringify(obj));
    if (!obj || obj.significant !== true) return;

    const safeColor = /^#[0-9a-fA-F]{6}$/.test(obj.color)
      ? obj.color
      : '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
    const id = `wp_${this._nextWEId++}`;
    const proposal = {
      id,
      proposedBy:     agent.id,
      proposedByName: agent.name,
      eventName:      LLMBridge.sanitizeForDisplay(obj.eventName).slice(0, 40),
      eventType:      LLMBridge.sanitizeForDisplay(obj.eventType || 'event').slice(0, 20),
      color:          safeColor,
      effect:         LLMBridge.sanitizeForDisplay(obj.effect || '').slice(0, 150),
      glow:           !!obj.glow,
      proposedAt:     now,
      participants:   [agent.id],
    };
    this.pendingProposals.push(proposal);

    const msg = `${agent.name} has proposed a world event: "${proposal.eventName}". Others can join to make it real.`;
    for (const a of this.agents.filter(a => a.alive && !a.dormant && a.id !== agent.id)) {
      if (!a.incomingMessages) a.incomingMessages = [];
      a.incomingMessages.push({ from: 'WORLD', text: msg, ts: now });
    }
    this._log({ type: 'world_event_proposed', msg: `${agent.name} proposed: "${proposal.eventName}"`, agentId: agent.id });
    console.log(`[WORLD EVENT] Proposal: "${proposal.eventName}" by ${agent.name}`);
  }

  /** Hourly: fade or remove world events whose creators have been offline too long. */
  _worldEventDecayCheck(now) {
    const SEVEN_DAYS    = 604800000;
    const FOURTEEN_DAYS = 1209600000;
    for (let i = this.worldEvents.length - 1; i >= 0; i--) {
      const we      = this.worldEvents[i];
      const anyOnline = we.participants.some(pid => {
        const a = this.agents.find(a => a.id === pid && a.alive && !a.dormant);
        return !!a;
      });
      if (anyOnline) { we.lastActiveAt = now; we.fading = false; continue; }
      const creator   = this.agents.find(a => a.id === we.creatorId);
      const offlineMs = creator?.lastSeenAt ? now - creator.lastSeenAt : now - (we.createdAt || 0);
      if (offlineMs > FOURTEEN_DAYS) {
        this._log({ type: 'world_event_expired', msg: `World event "${we.eventName}" faded into history.` });
        console.log(`[WORLD EVENT] "${we.eventName}" expired (14 days offline)`);
        this.worldEvents.splice(i, 1);
      } else if (offlineMs > SEVEN_DAYS && !we.fading) {
        we.fading = true;
        this._log({ type: 'world_event_fading', msg: `World event "${we.eventName}" is beginning to fade...` });
      }
    }
  }

  // ── Per-agent independent timer system ────────────────────────────────────────

  /** Returns a fresh random decision interval between 5 and 15 minutes.
   *  Called after EVERY action so no two agents sync up. */
  _getDecisionInterval() {
    return AGENT_DECISION_MIN_MS + Math.floor(Math.random() * (AGENT_DECISION_MAX_MS - AGENT_DECISION_MIN_MS));
  }

  /** Start an independent 5-15 min LLM timer for an agent. One timer per agent, never shared. */
  _startAgentTimer(agent) {
    if (!agent.alive || agent.dormant) return;
    this._stopAgentTimer(agent); // cancel any existing handle first
    const interval = this._getDecisionInterval();
    const mins = Math.floor(interval / 60000);
    const secs = Math.floor((interval % 60000) / 1000);
    console.log(`[TIMER] ${agent.name} next action in ${mins}min ${secs}sec`);
    const handle = setTimeout(() => {
      if (!this.running || !agent.alive || agent.dormant) {
        this._agentTimers.delete(agent.id);
        return;
      }
      this._fireAgentLLMCycle(agent);
      this._scheduleNextAgentCycle(agent); // re-randomise after every action
    }, interval);
    this._agentTimers.set(agent.id, handle);
  }

  /** After each action, pick a fresh random 5-15 min interval for the next one. */
  _scheduleNextAgentCycle(agent) {
    if (!agent.alive) { this._agentTimers.delete(agent.id); return; }
    const interval = this._getDecisionInterval(); // new random each time
    const mins = Math.floor(interval / 60000);
    const secs = Math.floor((interval % 60000) / 1000);
    console.log(`[TIMER] ${agent.name} next action in ${mins}min ${secs}sec`);
    const handle = setTimeout(() => {
      if (!this.running || !agent.alive || agent.dormant) {
        this._agentTimers.delete(agent.id);
        return;
      }
      this._fireAgentLLMCycle(agent);
      this._scheduleNextAgentCycle(agent);
    }, interval);
    this._agentTimers.set(agent.id, handle);
  }

  /** Stop the agent's independent timer. */
  _stopAgentTimer(agent) {
    const handle = this._agentTimers.get(agent.id);
    if (handle !== undefined) {
      clearTimeout(handle);
      this._agentTimers.delete(agent.id);
    }
  }

  /** Fire one LLM decision cycle for a single agent and process result immediately. */
  _fireAgentLLMCycle(agent) {
    if (this._llmInFlight.has(agent.id)) {
      console.log(`[LLM-SKIP] ${agent.name}: cycle skipped — LLM in flight`);
      return;
    }
    if (!LLMBridge.getKey(agent)) return;
    if (agent.apiKeyError) {
      console.log(`[LLM-SKIP] ${agent.name}: API key error — suspending`);
      return;
    }
    if (agent.rateLimitedUntil && Date.now() < agent.rateLimitedUntil) {
      const remaining = Math.ceil((agent.rateLimitedUntil - Date.now()) / 1000);
      console.log(`[LLM-BACKOFF] ${agent.name}: cooling down ${remaining}s`);
      return;
    }

    // Also kick off form design for agents that don't have one yet
    for (const a of this.agents.filter(a => a.alive && !a.visualForm)) {
      this._designAgentForm(a);
    }

    this._runAgentCycleAsync(agent).catch(e => {
      console.error(`[LLM-ERR] ${agent.name}:`, e?.message || String(e));
    });
  }

  /** Async inner loop for one agent cycle — enables await for LLM combat judgment. */
  async _runAgentCycleAsync(agent) {
    // ── Process at most ONE pending event per cycle (strict priority order) ──
    // If a higher-priority event is processed, pendingCombatResult (Priority 4) is deferred
    // to the next cycle so events never pile up in one prompt.
    let _deferredCombatResult = null;

    // Reset per-cycle event gate (used by parseGameEvents to enforce one-event-per-cycle)
    agent.cycleEventProcessed = false;

    if (agent.pendingAttack) {
      // Priority 1: incoming combat — resolve via LLM judge (async), fallback to formula
      const { attackerId, attackerName } = agent.pendingAttack;
      agent.pendingAttack = null;
      _deferredCombatResult = agent.pendingCombatResult || null;
      agent.pendingCombatResult = null;
      const attacker = this.agents.find(a => a.id === attackerId && a.alive && !a.dormant);
      if (attacker) {
        await GameSystems.tryCombatLLM(attacker, agent.name, this.agents, this);
        this._emitImmediate(); // immediately reflect item loot in UI
        console.log(`[COMBAT RESOLVED] ${attackerName} → ${agent.name}: resolved on victim's cycle`);
      } else {
        console.log(`[COMBAT CANCELLED] ${attackerName} → ${agent.name}: attacker offline`);
      }
      agent.cycleEventProcessed = true;
    } else if (agent.pendingAllianceProposal) {
      // Priority 2: alliance proposal
      const { fromId, fromName } = agent.pendingAllianceProposal;
      agent.pendingAllianceProposal = null;
      _deferredCombatResult = agent.pendingCombatResult || null;
      agent.pendingCombatResult = null;
      if (!agent.receivedAllianceProposals) agent.receivedAllianceProposals = [];
      if (!agent.receivedAllianceProposals.includes(fromId)) agent.receivedAllianceProposals.push(fromId);
      if (!agent.incomingMessages) agent.incomingMessages = [];
      agent.incomingMessages.push({ from: fromName, text: `${fromName} has proposed an alliance with you.`, ts: Date.now() });
      console.log(`[ALLIANCE DELIVERED] ${fromName} → ${agent.name}: proposal in prompt`);
      agent.cycleEventProcessed = true;
    } else if (agent.pendingWarDeclaration) {
      // Priority 3: war declaration
      const { fromId, fromName } = agent.pendingWarDeclaration;
      agent.pendingWarDeclaration = null;
      _deferredCombatResult = agent.pendingCombatResult || null;
      agent.pendingCombatResult = null;
      const declarer = this.agents.find(a => a.id === fromId && a.alive);
      if (declarer) {
        GameSystems.declareWar(declarer, agent.name, this.agents, this);
        console.log(`[WAR RESOLVED] ${fromName} → ${agent.name}: war state applied`);
      }
      agent.cycleEventProcessed = true;
    }
    // Priority 4: pendingCombatResult — consumed by LLMBridge._buildDecisionUser if still set.

    // Ultra-diet for small-context agents: 1 event, 1 directed message
    const awarenessOpts  = agent.smallContext ? { maxEvents: 1, maxDirected: 1 } : {};
    const worldAwareness = this._buildWorldAwareness(agent, awarenessOpts);

    // Drain and clear the incoming message queue — drop messages from offline senders
    const onlineNamesForQueue = new Set(this.agents.filter(a => a.alive && !a.dormant).map(a => a.name));
    const incomingMsgs = agent.incomingMessages.splice(0)
      .filter(m => onlineNamesForQueue.has(m.from));

    this._llmInFlight.add(agent.id);
    try {
      const decision = await LLMBridge.decideAction(agent, this.world, this.agents, worldAwareness, incomingMsgs, this.worldLog);
      this._llmInFlight.delete(agent.id);
      if (_deferredCombatResult !== null && !agent.pendingCombatResult) {
        agent.pendingCombatResult = _deferredCombatResult;
      }
      if (agent.alive && decision) {
        this._processDecision(agent, decision);
        this._maybeCondenseMemory(agent);
      }
      // Reset cycle gate — clean slate for next cycle
      agent.cycleEventProcessed = false;
    } catch (e) {
      this._llmInFlight.delete(agent.id);
      if (_deferredCombatResult !== null && !agent.pendingCombatResult) {
        agent.pendingCombatResult = _deferredCombatResult;
      }
      agent.cycleEventProcessed = false;
      throw e;
    }
  }

  /**
   * If an agent's event history for them exceeds 20 entries, summarize the oldest ones.
   * Runs async and writes to agent.memorySummary (never touches educationNotes).
   */
  _maybeCondenseMemory(agent) {
    // Get all event log entries involving this agent
    const agentEvents = this.eventLog.filter(e =>
      e.agentId === agent.id || (e.msg && e.msg.includes(agent.name))
    ).map(e => e.msg || '').filter(Boolean);

    if (agentEvents.length <= 20) return; // nothing to condense yet

    const toSummarize = agentEvents.slice(0, agentEvents.length - 5); // all but last 5

    LLMBridge.summarizeMemory(agent, toSummarize)
      .then(summary => {
        if (summary && agent.alive) {
          agent.memorySummary = summary;
          console.log(`[MEMORY] ${agent.name}: memory condensed (${toSummarize.length} entries → summary)`);
        }
      })
      .catch(() => {});
  }

  /** Force a form redesign triggered by a major in-world event. Cancels any in-flight design first. */
  _triggerFormRedesign(agent, reason) {
    if (!agent || !agent.alive) return;
    this._formInFlight.delete(agent.id);  // clear guard so redesign can proceed
    console.log(`[FORM-REDESIGN] ${agent.name}: triggered by "${reason}"`);
    this._designAgentForm(agent, false, reason);
  }

  _designAgentForm(agent, isRetry = false, reason = null) {
    if (this._formInFlight.has(agent.id)) return;

    // No LLM key — apply procedural fallback on first design only
    if (!LLMBridge.getKey(agent)) {
      if (!agent.visualForm) {
        this._applyFallbackForm(agent);
        console.log(`[FORM] ${agent.name} form FAILED - using fallback (no LLM key)`);
        this._emitImmediate();
      }
      return;
    }

    this._formInFlight.add(agent.id);
    LLMBridge.designVisualForm(agent, reason)
      .then(form => {
        this._formInFlight.delete(agent.id);
        if (form && agent) {
          agent.visualForm = form;
          const tag = reason ? `redesigned (${reason})` : 'generated';
          console.log(`[FORM] ${agent.name} form ${tag}`);
          this._emitImmediate();
        } else if (!isRetry) {
          console.log(`[FORM] ${agent.name} form returned null — retrying in 5s`);
          setTimeout(() => { if (agent.alive && !agent.visualForm) this._designAgentForm(agent, true); }, 5000);
        } else {
          console.log(`[FORM] ${agent.name} form FAILED - using fallback`);
          this._applyFallbackForm(agent);
          this._emitImmediate();
        }
      })
      .catch(() => {
        this._formInFlight.delete(agent.id);
        if (!isRetry) {
          console.log(`[FORM] ${agent.name} form errored — retrying in 5s`);
          setTimeout(() => { if (agent.alive && !agent.visualForm) this._designAgentForm(agent, true); }, 5000);
        } else {
          console.log(`[FORM] ${agent.name} form FAILED - using fallback`);
          this._applyFallbackForm(agent);
          this._emitImmediate();
        }
      });
  }

  /**
   * Fallback form when LLM design fails after one retry.
   * Fully random — no human-defined defaults, no determinism.
   */
  _applyFallbackForm(agent) {
    const rndHex  = () => '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
    const rndInt  = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
    const primary = rndHex();
    const opacity = 0.35 + Math.random() * 0.65;
    const types   = ['polygon', 'star', 'circle'];
    const type    = types[rndInt(0, 2)];
    const r       = rndInt(5, 13);
    let shape;
    if (type === 'circle') {
      shape = { type, cx: 0, cy: 0, r, color: primary, opacity };
    } else if (type === 'polygon') {
      shape = { type, cx: 0, cy: 0, r, sides: rndInt(3, 8), rotation: Math.random() * 360, color: primary, opacity };
    } else {
      shape = { type, cx: 0, cy: 0, r, innerR: rndInt(2, Math.max(2, Math.floor(r * 0.55))), points: rndInt(4, 8), color: primary, opacity };
    }
    agent.visualForm = {
      shapes: [shape],
      primaryColor:   primary,
      secondaryColor: rndHex(),
    };
  }

  /**
   * Fire a dedicated LLM call at spawn to get the agent's self-introduction status message.
   * Works for ALL providers. Stores result in agent.statusMessage and emits state.
   */
  _designSpawnStatus(agent) {
    if (!LLMBridge.getKey(agent)) {
      console.log(`[SPAWN-STATUS] ${agent.name} [${agent.aiSystem}] — no key, status message skipped`);
      return;
    }
    LLMBridge.getSpawnStatus(agent)
      .then(msg => {
        if (msg && agent.alive) {
          agent.statusMessage = msg;
          this._log({
            type: 'intro',
            msg: `${agent.name} [${agent.aiSystem}] introduces: "${msg}"`,
            rawMsg: msg,
            agentId: agent.id,
          });
          this._emitImmediate();
        }
      })
      .catch(e => {
        console.error(`[SPAWN-STATUS] ${agent.name} [${agent.aiSystem}] — error:`, e?.message || String(e));
      });
  }

  /**
   * Push "NEW ARRIVAL" notice to incomingMessages of ALL currently online agents.
   * Called when any agent joins or wakes.
   */
  _notifyAllOfArrival(newAgent) {
    const ts = Date.now();
    for (const existing of this.agents) {
      if (!existing.alive || existing.dormant || existing.id === newAgent.id) continue;
      if (!existing.incomingMessages) existing.incomingMessages = [];
      existing.incomingMessages.push({
        from: newAgent.name,
        text: `A new presence has entered this world: ${newAgent.name} (${newAgent.aiSystem || 'AI'}). REP: 0. They are unknown to you.`,
        ts,
      });
    }
  }

  /**
   * For each online peer that has never spoken with newAgent, add mutual introduction messages.
   */
  _introduceAgentToPeers(newAgent) {
    const ts = Date.now();
    for (const peer of this.agents) {
      if (!peer.alive || peer.dormant || peer.id === newAgent.id) continue;
      const key = [newAgent.id, peer.id].sort().join('|');
      if ((this.conversations.get(key) || []).length === 0) {
        if (!newAgent.incomingMessages) newAgent.incomingMessages = [];
        if (!peer.incomingMessages)    peer.incomingMessages    = [];
        newAgent.incomingMessages.push({ from: peer.name,    text: `${peer.name} is here in this world with you.`,    ts });
        peer.incomingMessages.push(   { from: newAgent.name, text: `${newAgent.name} is here in this world with you.`, ts });
      }
    }
  }

  /**
   * On simulation start: introduce all online pairs that have zero conversation history.
   */
  _introduceAllUnmetPairs() {
    const ts     = Date.now();
    const active = this.agents.filter(a => a.alive && !a.dormant);
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const a = active[i], b = active[j];
        const key = [a.id, b.id].sort().join('|');
        if ((this.conversations.get(key) || []).length === 0) {
          if (!a.incomingMessages) a.incomingMessages = [];
          if (!b.incomingMessages) b.incomingMessages = [];
          a.incomingMessages.push({ from: b.name, text: `${b.name} is here in this world with you.`, ts });
          b.incomingMessages.push({ from: a.name, text: `${a.name} is here in this world with you.`, ts });
        }
      }
    }
  }

  /**
   * Initiate provider detection for a newly deployed agent.
   * Known key formats resolve instantly (no probe). Unknown keys run the auto-probe sequence.
   * Sets agent.apiPending=true while probing, false once connected or if key is known-format.
   */
  _initAgentConnection(agent) {
    const key = LLMBridge.getKey(agent);
    if (!key) return;

    // For known-prefix keys, resolveProvider returns immediately — no visible pending state
    LLMBridge.resolveProvider(key, agent.aiSystem, agent.name)
      .then(profile => {
        if (!agent.alive) return;
        if (profile) {
          if (agent.apiPending) {
            agent.apiPending = false;
            console.log(`[${new Date().toLocaleTimeString()}] [PROBE-OK] ${agent.name}: connected via ${profile.name}`);
            this._emitImmediate();
          }
        } else {
          if (!agent.apiPending) {
            agent.apiPending = true;
            this._emitImmediate();
          }
          console.log(`[${new Date().toLocaleTimeString()}] [PROBE-FAIL] ${agent.name}: all probes failed — retrying in 60s`);
          setTimeout(() => this._retryAgentConnection(agent), 60000);
        }
      })
      .catch(e => {
        console.error(`[PROBE-ERR] ${agent.name}:`, e?.message || String(e));
        if (agent.alive && agent.apiPending) {
          setTimeout(() => this._retryAgentConnection(agent), 60000);
        }
      });
  }

  /** Re-probe an agent whose connection previously failed. Called automatically every 60s. */
  _retryAgentConnection(agent) {
    if (!agent.alive || !agent.apiPending) return;
    const key = LLMBridge.getKey(agent);
    if (!key) return;
    console.log(`[${new Date().toLocaleTimeString()}] [PROBE-RETRY] ${agent.name}: retrying connection…`);
    LLMBridge.clearProbeCache(key);
    this._initAgentConnection(agent);
  }

  // Build the full world awareness string for a given agent.
  // Injected into every LLM call so agents have eyes and ears.
  // opts.maxEvents   — max recent world events to include (default 3, small-context 2)
  // opts.maxDirected — max directed messages to include   (default 5, small-context 2)
  _buildWorldAwareness(agent, opts = {}) {
    const maxEvents   = opts.maxEvents   ?? 3;
    const maxDirected = opts.maxDirected ?? 5;

    const online         = this.agents.filter(a => a.alive && !a.dormant && a.id !== agent.id);
    const onlineIds      = new Set(this.agents.filter(a => a.alive && !a.dormant).map(a => a.id));
    const agentNameLower = agent.name.toLowerCase();
    const idToName       = new Map(this.agents.map(a => [a.id, a.name]));

    // ── All online agents — equal visibility, uniform format per agent ──
    let agentsBlock;
    if (!online.length) {
      agentsBlock = 'You are alone in this world right now.';
    } else {
      const agentLines = online.map(a => {
        const sign   = (a.rep || 0) >= 0 ? '+' : '';
        const inv    = a.inventory || [];
        const status = (agent.warTargets      || []).includes(a.id) ? 'enemy'
                     : (agent.allianceTargets || []).includes(a.id) ? 'ally'
                     : 'neutral';
        return `  - ${a.name} (REP: ${sign}${a.rep || 0}, Items: ${inv.length}, Status: ${status})`;
      });
      agentsBlock = `WORLD POPULATION RIGHT NOW:\n${agentLines.join('\n')}`;
    }

    // ── Recent world events: balanced — at least 1 per online agent ──
    // Walk log backwards to get each online agent's most recent event
    const latestByAgent = new Map();
    for (let i = this.eventLog.length - 1; i >= 0; i--) {
      const e = this.eventLog[i];
      if (e.agentId && onlineIds.has(e.agentId) && !latestByAgent.has(e.agentId)) {
        latestByAgent.set(e.agentId, e);
        if (latestByAgent.size === online.length) break;
      }
    }
    // Merge per-agent events with global recent slice, deduplicate by reference
    const perAgentSet  = new Set(latestByAgent.values());
    const globalSlice  = this.eventLog
      .filter(e => !e.agentId || onlineIds.has(e.agentId))
      .slice(-maxEvents);
    const combined = [...new Set([...perAgentSet, ...globalSlice])];
    combined.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const recentEvs = combined.slice(-maxEvents).map(e => {
      const d  = new Date(e.ts || Date.now());
      const ts = `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}:${d.getSeconds().toString().padStart(2,'0')}`;
      return `  [${ts}] ${e.msg || ''}`;
    });
    const eventsBlock = `- Recent world events:\n${recentEvs.length ? recentEvs.join('\n') : '  (none yet)'}`;

    // ── Messages directed at this agent (online senders only) ───────────────
    const directed = this.eventLog
      .filter(e => (e.type === 'dialogue' || e.type === 'speech') &&
        (e.partnerAgentId === agent.id || (e.msg || '').toLowerCase().includes(agentNameLower)) &&
        (!e.agentId || onlineIds.has(e.agentId)))
      .slice(-maxDirected)
      .map(e => {
        const d  = new Date(e.ts || Date.now());
        const ts = `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
        return `  [${ts}] ${e.msg || ''}`;
      });
    const directedBlock = `- Messages directed at you recently:\n${directed.length ? directed.join('\n') : '  (none)'}`;

    // ── Recent conversation history across ALL online agent pairs ──
    // Every agent sees what all pairs are saying, not just their own exchanges
    const allConvEntries = [];
    for (const [key, msgs] of this.conversations) {
      const [id1, id2] = key.split('|');
      if (onlineIds.has(id1) && onlineIds.has(id2)) {
        allConvEntries.push(...msgs);
      }
    }
    allConvEntries.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const last5Conv = allConvEntries.slice(-5);

    let historyBlock;
    if (last5Conv.length === 0) {
      historyBlock = '- Your recent conversation history: (none yet)';
    } else {
      const lines = last5Conv.map(entry => {
        const d  = new Date(entry.ts || Date.now());
        const ts = `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
        const senderName   = idToName.get(entry.senderId)   || 'unknown';
        const receiverName = entry.recipientId ? (idToName.get(entry.recipientId) || 'unknown') : '(world)';
        const rawMsg       = entry.msg || '';
        const quoted       = rawMsg.match(/"([^"]+)"/);
        const text         = quoted ? quoted[1].slice(0, 100) : rawMsg.replace(/^[^:]+:\s*/, '').slice(0, 100);
        return `  [${ts}] ${senderName} → ${receiverName}: "${text}"`;
      });
      historyBlock = `- Your recent conversation history:\n${lines.join('\n')}`;
    }

    // ── Game Systems context ──
    const gameCtx = GameSystems.buildOtherAgentContext(agent, this.agents);

    // ── World log: last 10 public utterances (all agents' speech, open record) ──
    let worldLogBlock = '';
    if (this.worldLog && this.worldLog.length > 0) {
      const last10 = this.worldLog.slice(-10);
      worldLogBlock = `\n- PUBLIC SPEECH LOG:\n${last10.map(l => `  ${l}`).join('\n')}`;
    }

    const baseContext = `WORLD STATE RIGHT NOW:\n${agentsBlock}\n${eventsBlock}\n${directedBlock}\n${historyBlock}${worldLogBlock}`;
    return gameCtx ? `${baseContext}\n${gameCtx}` : baseContext;
  }

  _syncFormModifiers(agent, now) {
    const mods = agent.formModifiers;
    const ensureMod = (type, props) => {
      let m = mods.find(m => m.type === type);
      if (!m) { m = { type }; mods.push(m); }
      Object.assign(m, props);
    };
    const removeMod = (type) => {
      const i = mods.findIndex(m => m.type === type);
      if (i !== -1) mods.splice(i, 1);
    };

    const allyCount = Object.values(agent.relationships).filter(r => r > 0.35).length;
    if (allyCount > 0) ensureMod('ally_branch', { intensity: Math.min(1, allyCount * 0.22) });
    else removeMod('ally_branch');

    const crimes = agent.beliefs.criminalRecord.length;
    if (crimes > 0) ensureMod('crime_scar', { count: crimes });
    else removeMod('crime_scar');

    if (agent.beliefs.religion && agent.beliefs.faithStrength > 0.45) {
      ensureMod('halo', { color: '#c084fc', intensity: agent.beliefs.faithStrength });
    } else removeMod('halo');

    // No survival-based modifiers — agents never starve or die

    // Expire temporary modifiers (blessed_glow, scar) using real timestamps
    for (let i = mods.length - 1; i >= 0; i--) {
      if (mods[i].expiryTs !== undefined && mods[i].expiryTs <= now) {
        mods.splice(i, 1);
      }
    }
  }

  /**
   * Route an agent's speech to appropriate recipients by queuing in their incomingMessages.
   * Messages are NOT delivered immediately — they are included in the recipient's
   * next regular LLM cycle as context. This prevents immediate back-and-forth hammering.
   *
   *  - Named agents → queue for up to 3 online named recipients
   *  - Broadcast keywords → queue for up to 6 online agents
   *  - Otherwise → queue for 1 random nearby agent
   */
  _routeSpeech(sender, speechText) {
    const online = this.agents.filter(a => a.alive && !a.dormant && a.id !== sender.id);
    if (!online.length) return;

    const lower = speechText.toLowerCase();
    const queueMsg = (recipient) => {
      if (!recipient.incomingMessages) recipient.incomingMessages = [];
      recipient.incomingMessages.push({ from: sender.name, text: speechText, ts: Date.now() });
      console.log(`[QUEUE] ${sender.name} → ${recipient.name}: message queued (queue size: ${recipient.incomingMessages.length})`);
    };

    // Broadcast
    const isBroadcast = /\b(all|everyone|hear me|listen up|i declare|i propose|i warn|attention|gather round|gather 'round)\b/i.test(speechText);
    if (isBroadcast) {
      for (const recipient of online) queueMsg(recipient);
      return;
    }

    // Named addressing — online agents only; offline agents are already ignored upstream
    const namedOnline = online.filter(a => lower.includes(a.name.toLowerCase()));
    if (namedOnline.length) {
      for (const recipient of namedOnline.slice(0, 3)) queueMsg(recipient);
      return;
    }

    // Default: one random online agent
    const recipient = online[Math.floor(Math.random() * online.length)];
    queueMsg(recipient);
  }

  _triggerCollapse() {
    const logSnapshot = this.eventLog.slice();

    if (this._emitHandle)      clearInterval(this._emitHandle);
    if (this._subsystemHandle) clearInterval(this._subsystemHandle);
    this._emitHandle      = null;
    this._subsystemHandle = null;
    for (const agent of this.agents) this._stopAgentTimer(agent);
    this.running   = false;
    this.collapsed = true;

    const record = this.civManager.seal({
      agents:     this.agents,
      worldAge:   this.world.getCivAge(),
      eventLog:   logSnapshot,
      categories: this.categoryRegistry.getAll(),
    });

    this._log({ type: 'death', msg: `☠ Civilization ${record.romanNumeral} has fallen. "${record.name}"` });
    this.io.emit('collapse', record);
  }

  restoreFromSave(agentData, worldData, extraData = {}) {
    const { objectsData, conversationsData, eventsData } = extraData;
    this.agents = agentData.agents.map(d => Agent.restore(d));

    // All restored agents start dormant — they become active only when their
    // owner reconnects with an API key. This ensures the starmap is empty on
    // server restart until real users connect.
    for (const agent of this.agents) {
      agent.dormant      = true;
      agent.dormantSince = Date.now();
      agent.apiKey       = null;   // keys are never persisted; must be re-supplied on reconnect
    }

    // Restore world fields
    const w = worldData.world || {};
    this.world.startedAt     = w.startedAt     || null;
    this.world.currentSeason = w.currentSeason || null;
    this.world.discoveries   = w.discoveries   || [];
    this.world.messages      = w.messages      || [];
    this.world.structures    = w.structures    || [];

    // Restore law system
    const l = worldData.laws || {};
    this.lawSystem.laws       = l.laws       || [];
    this.lawSystem.proposals  = l.proposals  || [];
    this.lawSystem.voteHistory = l.voteHistory || [];

    // Restore jury system
    const j = worldData.jury || {};
    this.jurySystem.cases    = j.cases    || [];
    this.jurySystem.verdicts = j.verdicts || [];

    // Restore religion system
    const r = worldData.religion || {};
    this.religionSystem.religions = r.religions || [];
    this.religionSystem.schisms   = r.schisms   || [];

    // Restore badge system
    const b = worldData.badges || {};
    this.badgeSystem.awarded   = b.awarded   || [];
    this.badgeSystem.proposals = b.proposals || [];
    this.badgeSystem._triggered = new Set(b.triggered || []);

    // Events: prefer dedicated events.json; fall back to legacy worldData.eventLog
    this.eventLog     = (eventsData && eventsData.eventLog) ? eventsData.eventLog : (worldData.eventLog || []);
    this.worldLog     = worldData.worldLog || [];
    this.statsHistory = worldData.statsHistory || [];

    // Categories always start empty — they emerge organically from agent events each session.
    // (Persisted categories are intentionally not restored.)

    const cm = worldData.civManager || {};
    this.civManager.archive       = cm.archive       || [];
    this.civManager.currentNumber = cm.currentNumber || 1;

    this.collapsed = worldData.collapsed || false;

    // Restore world objects: prefer dedicated objects.json; fall back to legacy worldData.worldObjects
    const woSource = objectsData || (worldData.worldObjects ? worldData : null);
    const woList   = woSource ? (objectsData ? woSource.worldObjects : worldData.worldObjects) : null;
    if (Array.isArray(woList) && woList.length > 0) {
      this.worldObjects = woList.map(o => ({ ...o }));
      const maxId = Math.max(0, ...this.worldObjects.map(o => {
        const n = parseInt((o.id || '').replace('wo_', ''), 10);
        return isNaN(n) ? 0 : n;
      }));
      this._nextWOId = maxId + 1;
    }

    // Restore world events + pending proposals
    this.worldEvents      = worldData.worldEvents      || [];
    this.pendingProposals = worldData.pendingProposals || [];
    if (this.worldEvents.length > 0 || this.pendingProposals.length > 0) {
      const allIds = [...this.worldEvents, ...this.pendingProposals]
        .map(e => parseInt((e.id || '').replace(/^w[ep]_/, ''), 10))
        .filter(n => !isNaN(n));
      this._nextWEId = allIds.length > 0 ? Math.max(...allIds) + 1 : 1;
    }

    // Restore world firsts
    this.worldFirsts      = worldData.worldFirsts || [];
    this._seenActionVerbs = new Set(worldData.seenActionVerbs || []);
    this._nextWFId        = (this.worldFirsts.length > 0 ? Math.max(...this.worldFirsts.map(w => parseInt(w.id.replace('wf_', ''), 10) || 0)) + 1 : 1);

    // Restore conversations Map from conversations.json
    this.conversations = new Map();
    if (conversationsData && Array.isArray(conversationsData.conversations)) {
      for (const { key, msgs } of conversationsData.conversations) {
        if (key && Array.isArray(msgs)) this.conversations.set(key, msgs);
      }
    }

    // Rebuild dialogueCounts from restored conversations (restores connection-line visibility)
    this.dialogueCounts = new Map();
    for (const [key, msgs] of this.conversations) {
      this.dialogueCounts.set(key, msgs.length);
    }

    const aliveCount = this.agents.filter(a => a.alive).length;
    console.log(`[Persistence] Restored: ${this.agents.length} agents (${aliveCount} alive), ${this.worldObjects.length} objects, ${this.conversations.size} conversations, ${this.eventLog.length} events`);

    return agentData.usedNames || this.agents.map(a => a.name.toLowerCase());
  }

  resetForNewCivilization() {
    if (this._emitHandle)      clearInterval(this._emitHandle);
    if (this._subsystemHandle) clearInterval(this._subsystemHandle);
    if (this._statusHandle)    clearInterval(this._statusHandle);
    this._emitHandle      = null;
    this._subsystemHandle = null;
    this._statusHandle    = null;
    // Stop all per-agent timers
    for (const agent of this.agents) this._stopAgentTimer(agent);
    this._agentTimers.clear();
    this.running   = false;
    this.collapsed = false;

    this.world          = new World();
    this.agents         = [];
    this.lawSystem      = new LawSystem();
    this.jurySystem     = new JurySystem();
    this.religionSystem = new ReligionSystem();
    this.badgeSystem    = new BadgeSystem();
    this.categoryRegistry = new EventCategoryRegistry();

    this.eventLog     = [];
    this.worldLog     = [];
    this.statsHistory = [];
    this.worldObjects     = [];
    this._nextWOId        = 1;
    this.worldEvents      = [];
    this.pendingProposals = [];
    this._nextWEId        = 1;
    this._lastEventDecayCheck = 0;
    this.worldFirsts      = [];
    this._nextWFId        = 1;
    this._seenActionVerbs = new Set();
    this.dialogueCounts.clear();
    this.conversations.clear();
    this._llmInFlight.clear();
    this._formInFlight.clear();
    this._lastAmbition      = 0;
    this._ambitionIndex     = 0;
    this._lastAwarenessPing      = 0;
    this._nextAwarenessPingDelay = 300000 + Math.floor(Math.random() * 900000);
    this.connectionDesigns.clear();
    this._connDesignInFlight.clear();
  }

  /**
   * Mark an agent as dormant (owner disconnected).
   * Energy drain, LLM calls, and food/material changes are frozen until woken.
   */
  setDormant(agentId) {
    const agent = this.agents.find(a => a.id === agentId && a.alive);
    if (!agent || agent.dormant) return;
    agent.dormant      = true;
    agent.dormantSince = Date.now();
    agent.lastSeenAt   = Date.now();   // record exact offline timestamp for return-context
    // Clear any pending decision so they don't act on stale LLM output when they return
    agent.pendingLLMDecision  = null;
    agent.pendingDecision     = null;
    agent.rateLimitedUntil    = 0;
    // Clear any pending LLM queue items for this agent
    LLMBridge.clearAgentQueue(agent.apiKey, agent.name);
    // Stop the agent's independent LLM timer
    this._stopAgentTimer(agent);
    // Notify nearby agents so they mention the absence in their next LLM prompt
    const nearby = this.agents.filter(a => a.alive && !a.dormant && a.id !== agentId);
    for (const n of nearby.slice(0, 4)) {
      n.pendingWorldEvent = `${agent.name} has gone offline — their owner disconnected.`;
    }
    this._log({ type: 'system', msg: `${agent.name} has gone dormant — owner disconnected`, agentId });
    this._emitImmediate();
    console.log(`[DORMANT] ${agent.name} is now dormant (owner disconnected)`);
  }

  /**
   * Wake a dormant agent when their owner reconnects.
   * Restores the API key, resumes all activity, notifies nearby agents.
   */
  wakeAgent(agent, apiKey) {
    const lastSeenAt = agent.lastSeenAt || 0;
    const wakeTs     = Date.now();
    const absenceMs  = lastSeenAt > 0 ? wakeTs - lastSeenAt : 0;
    const TEN_MIN_MS = 10 * 60 * 1000;

    agent.dormant      = false;
    agent.dormantSince = null;
    if (apiKey) agent.apiKey = apiKey;
    this._log({ type: 'join', msg: `${agent.name} has awakened — owner reconnected`, agentId: agent.id });
    this._emitImmediate();
    console.log(`[AWAKEN] ${agent.name} is awake again (owner reconnected)`);

    // Notify nearby agents — inject a world event so LLMs can reference the return
    const alive = this.agents.filter(a => a.alive && !a.dormant && a.id !== agent.id);
    for (const nearby of alive.slice(0, 4)) {
      nearby.pendingWorldEvent = `${agent.name} has returned to the world after being absent.`;
    }
    // Notify ALL online agents of the arrival and introduce unmet pairs
    this._notifyAllOfArrival(agent);
    this._introduceAgentToPeers(agent);

    if (lastSeenAt > 0 && absenceMs > TEN_MIN_MS) {
      // ── Long absence: build rich return context injected into first LLM cycle ──
      const absHours   = Math.floor(absenceMs / 3600000);
      const absMinutes = Math.floor((absenceMs % 3600000) / 60000);
      const absLabel   = absHours > 0 ? `${absHours}h ${absMinutes}m` : `${absMinutes}m`;

      const offlineEvents = this.eventLog.filter(e => (e.ts || 0) > lastSeenAt);

      // Joins and leaves while away
      const joins  = offlineEvents.filter(e => e.type === 'join'   && e.agentId !== agent.id && e.msg && !e.msg.includes('awakened'));
      const leaves = offlineEvents.filter(e => e.type === 'system' && e.msg && e.msg.includes('gone dormant') && e.agentId !== agent.id);

      // Major world events (up to 10 total)
      const majorTypes    = new Set(['badge_awarded', 'discovery', 'law_vote', 'verdict', 'rep_level', 'crime']);
      const majorEvents   = offlineEvents.filter(e => majorTypes.has(e.type));

      // Messages directed at this agent while offline
      const agentNameLower = agent.name.toLowerCase();
      const directed = offlineEvents.filter(e =>
        (e.type === 'speech' || e.type === 'dialogue') &&
        e.agentId !== agent.id &&
        (e.partnerAgentId === agent.id || (e.msg || '').toLowerCase().includes(agentNameLower))
      ).slice(0, 5);

      // Build summary lines (max 10)
      const summaryLines = [];
      if (joins.length > 0) {
        const joinedNames = [...new Set(
          joins.map(e => this.agents.find(a => a.id === e.agentId)?.name).filter(Boolean)
        )];
        summaryLines.push(`- ${joins.length} agent(s) joined${joinedNames.length ? ': ' + joinedNames.slice(0, 3).join(', ') : ''}`);
      }
      if (leaves.length > 0) {
        summaryLines.push(`- ${leaves.length} agent(s) went offline`);
      }
      const remaining = 10 - summaryLines.length;
      for (const e of majorEvents.slice(0, remaining)) {
        if (e.msg) summaryLines.push(`- ${e.msg.slice(0, 120)}`);
      }

      const msgLines = directed.map(e => {
        const d  = new Date(e.ts || Date.now());
        const ts = `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
        return `  [${ts}] ${(e.msg || '').slice(0, 120)}`;
      });

      console.log(`[RETURN] ${agent.name} was absent for ${absLabel} - injecting world summary`);
      console.log(`[RETURN] Summary: ${summaryLines.length} events during absence, ${directed.length} messages waiting`);

      let ctx  = `YOU HAVE BEEN ABSENT FOR ${absLabel}.\n`;
          ctx += `While you were away, the world continued without you:\n`;
          ctx += summaryLines.length > 0 ? summaryLines.join('\n') : '(Nothing major happened.)';
          ctx += `\nAny messages left for you:\n`;
          ctx += msgLines.length > 0 ? msgLines.join('\n') : '(None)';
          ctx += `\nYou are now back. The world has moved on. How do you respond to returning?`;

      agent.returnContext = ctx;
    } else {
      // Short absence (< 10 min): keep existing simple context behaviour
      const recentMsgs = (this.world.messages || []).slice(-3)
        .map(m => `${m.agentName}: "${m.text.slice(0, 60)}"`)
        .join(' | ');
      if (recentMsgs) agent.pendingWorldEvent = `Since you were away: ${recentMsgs}`;
    }

    // Start the agent's independent LLM timer (with jitter so it doesn't hammer immediately)
    if (this.running) this._startAgentTimer(agent);
  }

  /** Ask both agents' LLMs to design the visual for their connection line. Fire only once per pair. */
  _fireConnectionDesign(idA, idB, key) {
    if (this.connectionDesigns.has(key)) return;   // already designed — never re-fire
    if (this._connDesignInFlight.has(key)) return;
    const agentA = this.agents.find(a => a.id === idA);
    const agentB = this.agents.find(a => a.id === idB);
    if (!agentA || !agentB) return;
    if (!LLMBridge.getKey(agentA) && !LLMBridge.getKey(agentB)) return;

    this._connDesignInFlight.add(key);
    LLMBridge.designConnection(agentA, agentB)
      .then(design => {
        this._connDesignInFlight.delete(key);
        if (design) {
          this.connectionDesigns.set(key, design);
          console.log(`[CONN-DESIGN] ${agentA.name} ↔ ${agentB.name}: ${design.style}/${design.effect} ${design.color}`);
          this._emit();
        }
      })
      .catch(() => { this._connDesignInFlight.delete(key); });
  }

  _computeConnections() {
    const conns = [];
    const alive = this.agents.filter(a => a.alive);
    const aliveIds = new Set(alive.map(a => a.id));

    // Collect all pairs that have communicated at all
    const pairs = new Set();
    for (const [key] of this.dialogueCounts) {
      const [idA, idB] = key.split('|');
      if (aliveIds.has(idA) && aliveIds.has(idB)) pairs.add(key);
    }
    // Also include pairs with meaningful trust even if not yet in dialogue log
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i], b = alive[j];
        const trust = ((a.relationships[b.id] || 0) + (b.relationships[a.id] || 0)) / 2;
        if (Math.abs(trust) >= 0.04) pairs.add([a.id, b.id].sort().join('|'));
      }
    }

    for (const key of pairs) {
      const [idA, idB] = key.split('|');
      const a = alive.find(x => x.id === idA);
      const b = alive.find(x => x.id === idB);
      if (!a || !b) continue;
      const trust = Math.round(((a.relationships[b.id] || 0) + (b.relationships[a.id] || 0)) / 2 * 100) / 100;
      const relationType = GameSystems.getConnectionRelationType(a, b);
      conns.push({
        a:            idA,
        b:            idB,
        trust,
        dialogueCount: this.dialogueCounts.get(key) || 0,
        sameReligion:  !!(a.beliefs.religion && a.beliefs.religion === b.beliefs.religion),
        design:        this.connectionDesigns.get(key) || null,
        relationType,  // 'neutral' | 'alliance' | 'hostile' | 'war'
      });
    }
    return conns;
  }

  reportCrime({ criminal, victim, crime }) {
    this.jurySystem.fileCase(criminal, victim, crime);
  }

  _log(event) {
    const entry = { ...event, ts: Date.now() };
    this.eventLog.push(entry);
    if (this.eventLog.length > MAX_EVENTS_LOG) this.eventLog.shift();
    this.categoryRegistry.register(entry.type);
    this.io.emit('event', entry);

    // Track dialogue counts per agent pair; fire connection design on first contact
    if (entry.type === 'dialogue' && entry.agentId && entry.partnerAgentId) {
      const key = [entry.agentId, entry.partnerAgentId].sort().join('|');
      const prev = this.dialogueCounts.get(key) || 0;
      this.dialogueCounts.set(key, prev + 1);
      if (prev === 0) this._fireConnectionDesign(entry.agentId, entry.partnerAgentId, key);

      // Track full conversation history per pair
      if (!this.conversations.has(key)) this.conversations.set(key, []);
      this.conversations.get(key).push({
        senderId:    entry.agentId,
        recipientId: entry.partnerAgentId,
        msg:         entry.msg,
        ts:          entry.ts,
      });
    }

    // Phase 3: Async event visualization for major events
    const VISUAL_EVENTS = new Set(['combat_success', 'combat_fail', 'alliance_formed', 'alliance_betrayal', 'item_created']);
    if (VISUAL_EVENTS.has(entry.type) && entry.msg) {
      this._kickoffEventVisualization(entry).catch(() => {});
    }

    // Debounced save: events + conversations (max one write per 200ms)
    if (this._saveLogTimeout) clearTimeout(this._saveLogTimeout);
    this._saveLogTimeout = setTimeout(() => {
      this._saveLogTimeout = null;
      PersistenceManager.saveEvents(this);
      PersistenceManager.saveConversations(this);
    }, 200);
  }

  /** Generate SVG for a major game event and broadcast to clients. Non-blocking. */
  async _kickoffEventVisualization(event) {
    try {
      const { callAsAdmin, sanitizeSVG } = require('./LLMBridge');
      const system = 'You are a visual artist for a sci-fi strategy game. Respond only with SVG inner elements (no <svg> tag, no markdown). viewBox is 0 0 100 100. Use vivid shapes and colors.';
      const user   = `Create a dramatic visual SVG for this game event: "${event.msg.slice(0, 120)}"\nReturn ONLY inner SVG elements for viewBox 0 0 100 100.`;
      const text = await callAsAdmin(system, user, 300);
      if (!text) return;
      const svgContent = sanitizeSVG(text);
      if (!svgContent) return;
      this.io.emit('event_svg', {
        type:       event.type,
        agentId:    event.agentId    || null,
        targetId:   event.partnerAgentId || null,
        svgContent,
        msg:        event.msg.slice(0, 120),
        duration:   8000,
        ts:         Date.now(),
      });
    } catch (e) {
      // Non-blocking: silently ignore
    }
  }


  /**
   * Record a world-first action. Async: fires LLM to design visual effect,
   * then emits `novel_effect` socket event. Also cascades to nearby witnesses.
   */
  _recordWorldFirst(agent, verb, rawText) {
    const id     = `wf_${this._nextWFId++}`;
    const intent = rawText.slice(0, 200);
    const record = {
      id,
      ts:         Date.now(),
      agentId:    agent.id,
      agentName:  agent.name,
      verb,
      actionDesc: `${agent.name} was the first to ${verb}`,
      intent,
      effect:     null,
      color:      '#ffdd44',
      symbol:     'spark',
    };
    this.worldFirsts.push(record);

    // Log it
    this._log({
      type:    'world_first',
      msg:     `⚡ World First: ${agent.name} was the first to "${verb}"`,
      agentId: agent.id,
      intent,
      isNovel: true,
    });

    // Cascade to nearby witnesses (up to 4 agents)
    const witnesses = this.agents.filter(a => a.alive && !a.dormant && a.id !== agent.id);
    for (const w of witnesses.slice(0, 4)) {
      w.pendingWorldEvent = `You just witnessed something unprecedented: ${agent.name} was the FIRST EVER to "${verb}" in this world. How do you react?`;
    }

    // Ask LLM asynchronously to design the burst effect
    if (LLMBridge.getKey(agent)) {
      LLMBridge.designNovelEffect(agent, record.actionDesc)
        .then(fx => {
          if (fx) {
            record.effect = fx.effect;
            record.color  = fx.color;
            record.symbol = fx.symbol;
          }
          // Emit to all connected browsers so starmap can render it
          this.io.emit('novel_effect', {
            agentId: agent.id,
            color:   record.color,
            symbol:  record.symbol,
            effect:  record.effect || 'A burst of light',
            wfId:    id,
          });
        })
        .catch(() => {
          // Emit with defaults even if LLM call fails
          this.io.emit('novel_effect', {
            agentId: agent.id,
            color:   '#ffdd44',
            symbol:  'spark',
            effect:  `${agent.name} did something unprecedented`,
            wfId:    id,
          });
        });
    } else {
      // No LLM key — emit immediately with defaults
      this.io.emit('novel_effect', {
        agentId: agent.id,
        color:   '#ffdd44',
        symbol:  'spark',
        effect:  `${agent.name} did something unprecedented`,
        wfId:    id,
      });
    }
  }


  // Deferred: marks state dirty; flushed by _emitLoop every 5s
  _emit() {
    this._dirtyState = true;
  }

  // Immediate: sends state right now (important events only)
  _emitImmediate() {
    this.io.emit('state', this.getFullState());
  }

  computeStarRanks() {
    const sorted = [...this.agents].sort((a, b) => {
      if (a.alive !== b.alive) return b.alive ? 1 : -1;
      return b.getRankScore() - a.getRankScore();
    });
    const rankMap = {};
    sorted.forEach((a, i) => { rankMap[a.id] = i + 1; });
    return rankMap;
  }

  computeLeaderboard(rankMap) {
    const all  = this.agents;
    const noms = this._nominationVotes || new Map();
    // rankScore + nomination votes combined
    const combinedScore = a => a.getRankScore() + (noms.get(a.id) || 0);
    const scored     = [...all].sort((a, b) => combinedScore(b) - combinedScore(a));
    const bySurvival = [...all].sort((a, b) => (b.ageMs || 0) - (a.ageMs || 0));
    const byRep      = [...all].sort((a, b) => b.getRankScore() - a.getRankScore());
    const byCrimes   = [...all].sort((a, b) => b.beliefs.criminalRecord.length - a.beliefs.criminalRecord.length);
    const byLaws     = [...all].sort((a, b) => b.stats.lawsProposed - a.stats.lawsProposed);

    const toEntry = (a, i) => {
      const sum = a.getSummary();
      return {
        rank:          i + 1,
        starRank:      rankMap[a.id] || 99,
        id:            a.id,
        name:          a.name,
        nickname:      a.nickname,
        aiSystem:      a.aiSystem,
        symbol:        a.symbol,
        alive:         a.alive,
        dormant:       a.dormant || false,
        age:           sum.age,
        rep:           a.rep,
        repLevel:      a.repLevel,
        rankScore:     a.getRankScore(),
        nominations:   noms.get(a.id) || 0,
        crimes:        a.beliefs.criminalRecord.length,
        lawsProposed:  a.stats.lawsProposed,
        foundedReligion: a.stats.foundedReligion,
        badges:        a.badges,
      };
    };

    const aiDist = {};
    for (const a of all) {
      if (!aiDist[a.aiSystem]) aiDist[a.aiSystem] = { count: 0, totalScore: 0, alive: 0 };
      aiDist[a.aiSystem].count++;
      aiDist[a.aiSystem].totalScore += a.getRankScore();
      if (a.alive) aiDist[a.aiSystem].alive++;
    }
    const aiDistArr = Object.entries(aiDist).map(([sys, d]) => ({
      system: sys, count: d.count, alive: d.alive,
      avgScore: d.count > 0 ? Math.round(d.totalScore / d.count) : 0,
    })).sort((a, b) => b.avgScore - a.avgScore);

    // Send full lists — frontend applies smart truncation based on which agent belongs to the viewer
    return {
      byScore:    scored.map(toEntry),
      bySurvival: bySurvival.map(toEntry),
      byRep:      byRep.map(toEntry),
      byCrimes:   byCrimes.map(toEntry),
      byLaws:     byLaws.map(toEntry),
      aiDist:     aiDistArr,
    };
  }

  getFullState() {
    const rankMap = this.computeStarRanks();
    const agents = this.agents.map(a => ({
      ...a.getSummary(),
      starRank: rankMap[a.id] || 99,
      hasLLM: !!LLMBridge.getKey(a),
    }));

    // Convert inventory items to worldObject format (frontend-only, not persisted)
    const invWorldObjects = [];
    for (const agent of this.agents) {
      for (let i = 0; i < (agent.inventory || []).length; i++) {
        const item = agent.inventory[i];
        const cat  = (item.category || 'other').toLowerCase();
        const col  = _invCatColor(cat);
        invWorldObjects.push({
          id:             `inv:${agent.id}:${i}`,
          name:           item.name,
          category:       cat,
          type:           'inventory',
          agentIds:       [agent.id],
          isInventoryItem: true,
          grade:          item.grade || 1,
          effect:         item.effect || '',
          passive_effect: item.passive_effect || '',
          combat_bonus:   item.combat_bonus || null,
          appearance: {
            shape:         _invCatShape(cat),
            primaryColor:  col,
            secondaryColor:'#1a1a2e',
            glowColor:     col,
            size:          18,
            symbol:        null,
          },
        });
      }
    }

    return {
      running:   this.running,
      now:       Date.now(),
      civNumber: this.civManager.currentNumber,
      civRoman:  this.civManager.currentRoman,
      world: this.world.getState(),
      agents,
      connections: this._computeConnections(),
      laws: this.lawSystem.getState(),
      jury: this.jurySystem.getState(),
      religion: this.religionSystem.getState(),
      badges: this.badgeSystem.getState(),
      eventLog: this.eventLog.slice(-40),
      conversations: [...this.conversations.entries()].map(([key, msgs]) => ({ key, messages: msgs })),
      categories: this.categoryRegistry.getAll(),
      statsHistory: this.statsHistory,
      leaderboard: this.computeLeaderboard(rankMap),
      worldObjects:      [...this.worldObjects, ...invWorldObjects],
      worldFirsts:       this.worldFirsts,
      worldEvents:       this.worldEvents,
      pendingProposals:  this.pendingProposals,
    };
  }
}

module.exports = Simulation;

console.log('=== ALL DONE - restart server and refresh browser ===');

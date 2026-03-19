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

const EMIT_INTERVAL_MS     = 5000;   // batch-flush dirty state to browser (5s)
const DECISION_INTERVAL_MS = 30000;  // agent decisions + subsystems (30s reduces API call rate)
const MAX_EVENTS_LOG       = 500;

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
    this.statsHistory = [];
    this.categoryRegistry = new EventCategoryRegistry();
    this.civManager = new CivilizationManager();
    this.collapsed  = false;

    // World objects — persistent visual markers on the starmap; created purely by AI decisions
    this.worldObjects = [];
    this._nextWOId = 1;

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
    this._lastAwarenessPing = 0;  // spontaneous neighbour awareness, no LLM call

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
    this._subsystemHandle = setInterval(() => this._subsystemLoop(), DECISION_INTERVAL_MS);
    // 30-second status log + full save
    this._statusHandle    = setInterval(() => this._statusSave(), 30000);
    this._log({ type: 'system', msg: 'Simulation started. No human intervention allowed.' });
    // Start per-agent independent timers (with jitter) for all live agents
    for (const agent of this.agents.filter(a => a.alive && !a.dormant)) {
      this._startAgentTimer(agent);
    }
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

    // ── 4. Spontaneous awareness ping — no LLM call, just queue a nudge ──
    if (now - this._lastAwarenessPing >= 60000) {
      this._lastAwarenessPing = now;
      const active = this.agents.filter(a => a.alive && !a.dormant);
      if (active.length >= 2) {
        const a = active[Math.floor(Math.random() * active.length)];
        const b = active.filter(x => x.id !== a.id)[Math.floor(Math.random() * (active.length - 1))];
        if (a && b) {
          if (!a.incomingMessages) a.incomingMessages = [];
          if (!b.incomingMessages) b.incomingMessages = [];
          a.incomingMessages.push({ from: b.name, text: `${b.name} is nearby and aware of you.`, ts: now });
          b.incomingMessages.push({ from: a.name, text: `${a.name} is nearby and aware of you.`, ts: now });
          console.log(`[AWARENESS] ${a.name} ↔ ${b.name} pinged`);
        }
      }
    }

    // ── 5. Law voting ──
    if (now - this._lastLawVote >= LAW_VOTE_INTERVAL) {
      this._lastLawVote = now;
      const lawResults = this.lawSystem.runVoting(this.agents.filter(a => a.alive && !a.dormant));
      for (const r of lawResults) {
        this._log({
          type: 'law_vote',
          msg: r.passed
            ? `LAW PASSED: "${r.law.text}" (${r.law.votes.yes}y/${r.law.votes.no}n)`
            : `LAW REJECTED: "${r.law.text}" (${r.law.votes.yes}y/${r.law.votes.no}n)`,
        });
      }
    }

    // ── 5. Jury trials ──
    if (now - this._lastJuryTrial >= JURY_INTERVAL) {
      this._lastJuryTrial = now;
      const verdicts = this.jurySystem.runTrials(this.agents.filter(a => a.alive && !a.dormant));
      for (const v of verdicts) this._log(v);
    }

    // ── 6. Religion sync ──
    if (now - this._lastReligionSync >= RELIGION_INTERVAL) {
      this._lastReligionSync = now;
      this.religionSystem.syncMembers(this.agents.filter(a => a.alive && !a.dormant));
      for (const religion of this.religionSystem.religions) {
        const founder = this.agents.find(a => a.id === religion.founder);
        if (founder && !founder.stats.foundedReligion) {
          founder.stats.foundedReligion = religion.name;
        }
      }
    }

    // ── 6b. Prune stale world objects ──
    this._pruneWorldObjects();

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
        ts:        now,
        alive:     this.agents.filter(a => a.alive).length,
        laws:      this.lawSystem.laws.length,
        religions: this.religionSystem.religions.length,
        crimes:    this.jurySystem.verdicts.length,
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

    // ── 10. Ambition trigger — every 60s, nudge one active agent to think bigger ──
    if (now - this._lastAmbition >= 60000) {
      this._lastAmbition = now;
      const active = this.agents.filter(a => a.alive && !a.dormant);
      if (active.length > 0) {
        this._ambitionIndex = this._ambitionIndex % active.length;
        const target = active[this._ambitionIndex];
        target.ambitionPending = true;
        this._ambitionIndex = (this._ambitionIndex + 1) % active.length;
        console.log(`[AMBITION] Triggered for ${target.name}`);
      }
    }

    // ── 11. Auto-save ──
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
      // Route only if message wasn't exclusively directed at offline agents
      if (namedTarget || offlineNamed.length === 0) {
        this._routeSpeech(agent, speechLine);
      }
    }

    if (decision.invents) {
      this._log({ type: 'discovery', msg: `${agent.name} invents: "${decision.invents}"`, agentId: agent.id });
    }

    const event = agent.act(action, this.world, this.agents, this.lawSystem, this, decision);
    agent.decisionsCount++;
    agent.lastDecisionAt = now;

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

    // ── Object actions ──
    const rawText = decision.speech || decision.dialogue || '';
    if (rawText) {
      const agentObjs = this.worldObjects.filter(o => o.agentIds && o.agentIds[0] === agent.id);
      const objActions = LLMBridge.parseObjectActions(rawText, agentObjs);
      if (objActions.length) this._applyObjectActions(agent, objActions);

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

    this._emit();
  }

  // ── Per-agent independent timer system ────────────────────────────────────────

  /** Returns a random decision interval between 120 s and 180 s (2–3 min).
   *  Called fresh each cycle so every agent gets a different wait time,
   *  naturally spreading API calls over time. */
  _getDecisionInterval() {
    return 120000 + Math.floor(Math.random() * 60000); // 120 000–180 000 ms
  }

  /** Start an independent LLM timer for an agent with random jitter. */
  _startAgentTimer(agent) {
    if (!agent.alive || agent.dormant) return;
    this._stopAgentTimer(agent); // clear any existing timer
    const jitter   = 1000 + Math.floor(Math.random() * 4000); // 1-5s jitter
    const interval = this._getDecisionInterval();
    console.log(`[TIMER-START] ${agent.name}: first cycle in ${jitter}ms, then every ${interval / 1000}s`);
    const handle = setTimeout(() => {
      if (!this.running || !agent.alive || agent.dormant) {
        this._agentTimers.delete(agent.id);
        return;
      }
      this._fireAgentLLMCycle(agent);
      this._scheduleNextAgentCycle(agent);
    }, jitter);
    this._agentTimers.set(agent.id, handle);
  }

  /** Schedule the next LLM cycle for an agent using the current interval. */
  _scheduleNextAgentCycle(agent) {
    if (!agent.alive) { this._agentTimers.delete(agent.id); return; }
    const interval = this._getDecisionInterval();
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

    // Ultra-diet for small-context agents: 1 event, 1 directed message
    const awarenessOpts  = agent.smallContext ? { maxEvents: 1, maxDirected: 1 } : {};
    const worldAwareness = this._buildWorldAwareness(agent, awarenessOpts);

    // Drain and clear the incoming message queue — drop messages from offline senders
    const onlineNamesForQueue = new Set(this.agents.filter(a => a.alive && !a.dormant).map(a => a.name));
    const incomingMsgs = agent.incomingMessages.splice(0)
      .filter(m => onlineNamesForQueue.has(m.from));

    this._llmInFlight.add(agent.id);
    LLMBridge.decideAction(agent, this.world, this.agents, worldAwareness, incomingMsgs)
      .then(decision => {
        this._llmInFlight.delete(agent.id);
        if (agent.alive && decision) {
          this._processDecision(agent, decision);
          // Check if memory needs summarization (async, non-blocking)
          this._maybeCondenseMemory(agent);
        }
      })
      .catch(e => {
        this._llmInFlight.delete(agent.id);
        console.error(`[LLM-ERR] ${agent.name}:`, e?.message || String(e));
      });

    // Also kick off form design for agents that don't have one yet
    for (const a of this.agents.filter(a => a.alive && !a.visualForm)) {
      this._designAgentForm(a);
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

  _designAgentForm(agent, isRetry = false) {
    if (this._formInFlight.has(agent.id)) return;

    // No LLM key — apply procedural fallback immediately, no waiting
    if (!LLMBridge.getKey(agent)) {
      if (!agent.visualForm) {
        this._applyFallbackForm(agent);
        console.log(`[FORM] ${agent.name} form FAILED - using fallback (no LLM key)`);
        this._emitImmediate();
      }
      return;
    }

    this._formInFlight.add(agent.id);
    LLMBridge.designVisualForm(agent)
      .then(form => {
        this._formInFlight.delete(agent.id);
        if (form && agent) {
          agent.visualForm = form;
          console.log(`[FORM] ${agent.name} form generated`);
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

    // ── Other agents present ────────────────────────────────────────────────
    let agentsBlock;
    if (!online.length) {
      agentsBlock = 'You are alone in this world right now.';
    } else {
      const agentLines = online.slice(0, 6).map(a => {
        const lastMsg = (this.world.messages || []).filter(m => m.agentId === a.id).slice(-1)[0];
        const lastSaid = lastMsg ? `said: "${lastMsg.text.slice(0, 100)}"` : 'silent';
        return `  ${a.name} [${a.aiSystem}]: ${lastSaid}`;
      });
      agentsBlock = `- Other agents present:\n${agentLines.join('\n')}`;
    }

    // ── Recent world events (online agents only — offline agents invisible) ─
    const recentEvs = this.eventLog
      .filter(e => !e.agentId || onlineIds.has(e.agentId))
      .slice(-maxEvents)
      .map(e => {
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

    // ── This agent's own recent conversation history (last 5 sent or received)
    // Source 1: pair-keyed conversation records (type:dialogue events)
    const myConvEntries = [];
    for (const [key, msgs] of this.conversations) {
      const [id1, id2] = key.split('|');
      if (id1 === agent.id || id2 === agent.id) {
        myConvEntries.push(...msgs);
      }
    }
    // Source 2: speech events from eventLog involving this agent
    for (const e of this.eventLog) {
      if (e.type !== 'speech') continue;
      const isSent     = e.agentId === agent.id;
      const isReceived = !isSent &&
        (e.partnerAgentId === agent.id || (e.msg || '').toLowerCase().includes(agentNameLower));
      if (!isSent && !isReceived) continue;
      if (myConvEntries.some(c => c.ts === e.ts && c.msg === e.msg)) continue; // dedup
      myConvEntries.push({
        senderId:    isSent ? agent.id : (e.agentId || null),
        recipientId: isSent ? null     : agent.id,
        msg:         e.msg || '',
        ts:          e.ts,
      });
    }
    myConvEntries.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    // Only show history involving currently online agents — offline agents invisible
    const last5Conv = myConvEntries
      .filter(entry => {
        const sid = entry.senderId;
        const rid = entry.recipientId;
        const senderOk    = !sid || sid === agent.id || onlineIds.has(sid);
        const recipientOk = !rid || rid === agent.id || onlineIds.has(rid);
        return senderOk && recipientOk;
      })
      .slice(-5);

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

    return `WORLD STATE RIGHT NOW:\n${agentsBlock}\n${eventsBlock}\n${directedBlock}\n${historyBlock}`;
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
      for (const recipient of online.slice(0, 6)) queueMsg(recipient);
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
      agents:       this.agents,
      worldAge:     this.world.getCivAge(),
      eventLog:     logSnapshot,
      categories:   this.categoryRegistry.getAll(),
      lawCount:     this.lawSystem.laws.length,
      religionCount: this.religionSystem.religions.length,
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
    this.statsHistory = [];
    this.worldObjects     = [];
    this._nextWOId        = 1;
    this.worldFirsts      = [];
    this._nextWFId        = 1;
    this._seenActionVerbs = new Set();
    this.dialogueCounts.clear();
    this.conversations.clear();
    this._llmInFlight.clear();
    this._formInFlight.clear();
    this._lastAmbition      = 0;
    this._ambitionIndex     = 0;
    this._lastAwarenessPing = 0;
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
      conns.push({
        a:            idA,
        b:            idB,
        trust,
        dialogueCount: this.dialogueCounts.get(key) || 0,
        sameReligion:  !!(a.beliefs.religion && a.beliefs.religion === b.beliefs.religion),
        design:        this.connectionDesigns.get(key) || null,
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

    // Debounced save: events + conversations (max one write per 200ms)
    if (this._saveLogTimeout) clearTimeout(this._saveLogTimeout);
    this._saveLogTimeout = setTimeout(() => {
      this._saveLogTimeout = null;
      PersistenceManager.saveEvents(this);
      PersistenceManager.saveConversations(this);
    }, 200);
  }

  /**
   * Apply object actions parsed from an agent's LLM output.
   * Only the creator can delete/modify/group their own objects.
   */
  _applyObjectActions(agent, actions) {
    if (!actions || !actions.length) return;
    for (const action of actions) {
      if (action.type === 'create') {
        // No duplicate name for this agent
        const dup = this.worldObjects.find(o =>
          o.agentIds && o.agentIds[0] === agent.id &&
          o.name.toLowerCase() === action.name.toLowerCase()
        );
        if (!dup) {
          this._spawnWorldObject('object', action.name, `Created by ${agent.name}`, [agent.id]);
          this._log({ type: 'object_create', msg: `${agent.name} created object "${action.name}"`, agentId: agent.id });
        }

      } else if (action.type === 'delete') {
        const idx = this.worldObjects.findIndex(o => o.id === action.id && o.agentIds && o.agentIds[0] === agent.id);
        if (idx !== -1) {
          const group = this.worldObjects[idx];
          this.worldObjects.splice(idx, 1);
          // Free any children if it was a group
          for (const o of this.worldObjects) {
            if (o.parentGroupId === group.id) delete o.parentGroupId;
          }
          PersistenceManager.saveObjects(this);
          this._log({ type: 'object_delete', msg: `${agent.name} destroyed "${action.name}"`, agentId: agent.id });
        }

      } else if (action.type === 'modify') {
        const obj = this.worldObjects.find(o => o.id === action.id && o.agentIds && o.agentIds[0] === agent.id);
        if (obj) {
          obj.desc = action.newDesc.slice(0, 200);
          PersistenceManager.saveObjects(this);
          this._log({ type: 'object_modify', msg: `${agent.name} modified "${action.name}" — changed to: ${action.newDesc.slice(0, 80)}`, agentId: agent.id });
        }

      } else if (action.type === 'group') {
        const groupObj = {
          id:          `wo_${this._nextWOId++}`,
          type:        'group',
          name:        action.name.slice(0, 60),
          desc:        `Grouped by ${agent.name}`,
          creatorId:   agent.id,
          creatorName: agent.name,
          agentIds:    [agent.id],
          childIds:    action.childIds,
          spawnTs:     Date.now(),
          expiryTs:    null,
          appearance:  null,
          position:    null,
        };
        this.worldObjects.push(groupObj);
        for (const childId of action.childIds) {
          const child = this.worldObjects.find(o => o.id === childId);
          if (child) child.parentGroupId = groupObj.id;
        }
        PersistenceManager.saveObjects(this);
        if (LLMBridge.getKey(agent)) {
          LLMBridge.designWorldObject(agent, action.name, 'group').then(ap => {
            if (ap && groupObj) { groupObj.appearance = ap; PersistenceManager.saveObjects(this); }
          }).catch(() => {});
          LLMBridge.designObjectSVG(agent, action.name).then(svg => {
            if (svg && groupObj) { groupObj.visualSVG = svg; PersistenceManager.saveObjects(this); }
          }).catch(() => {});
        }
        this._log({ type: 'object_group', msg: `${agent.name} organized objects into group "${action.name}"`, agentId: agent.id });

      } else if (action.type === 'ungroup') {
        const grp = this.worldObjects.find(o => o.id === action.id && o.agentIds && o.agentIds[0] === agent.id && o.type === 'group');
        if (grp) {
          for (const childId of (grp.childIds || [])) {
            const child = this.worldObjects.find(o => o.id === childId);
            if (child) delete child.parentGroupId;
          }
          this.worldObjects = this.worldObjects.filter(o => o.id !== grp.id);
          PersistenceManager.saveObjects(this);
          this._log({ type: 'object_ungroup', msg: `${agent.name} separated group "${action.name}"`, agentId: agent.id });
        }
      }
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

  _spawnWorldObject(type, name, desc, agentIds, { expiryTs = null } = {}) {
    const id = `wo_${this._nextWOId++}`;
    const primaryAgentId = agentIds && agentIds[0];
    const creatorAgent   = primaryAgentId ? this.agents.find(a => a.id === primaryAgentId) : null;
    const obj = {
      id, type,
      name:        (name || '').slice(0, 60),
      desc:        (desc || '').slice(0, 200),
      creatorId:   creatorAgent ? creatorAgent.id   : null,
      creatorName: creatorAgent ? creatorAgent.name : null,
      agentIds:    agentIds || [],
      spawnTs:     Date.now(),
      expiryTs,
      appearance:  null,  // filled asynchronously by LLM
      visualSVG:   null,  // filled asynchronously by LLM
      purpose:     null,  // AI self-description of why it was created
      category:    null,  // AI-assigned category (free-form, no restrictions)
      position:    null,  // reserved for future spatial placement
    };
    this.worldObjects.push(obj);
    // Persist immediately — world objects live forever
    PersistenceManager.saveObjects(this);

    // Fire async LLM calls to design the object's appearance and SVG visualization
    if (creatorAgent && LLMBridge.getKey(creatorAgent)) {
      LLMBridge.designWorldObject(creatorAgent, name, type).then(appearance => {
        if (appearance && obj) {
          obj.appearance = appearance;
          PersistenceManager.saveObjects(this);
        }
      }).catch(() => {});

      LLMBridge.designObjectSVG(creatorAgent, name).then(svg => {
        if (svg && obj) {
          obj.visualSVG = svg;
          PersistenceManager.saveObjects(this);
        }
      }).catch(() => {});

      LLMBridge.categorizeWorldObject(creatorAgent, name).then(meta => {
        if (meta && obj) {
          if (meta.purpose)  obj.purpose  = meta.purpose;
          if (meta.category) obj.category = meta.category;
          PersistenceManager.saveObjects(this);
        }
      }).catch(() => {});
    }
  }


  _pruneWorldObjects() {
    const now    = Date.now();
    const before = this.worldObjects.length;
    this.worldObjects = this.worldObjects.filter(o => {
      // Only prune objects that were explicitly given an expiry timestamp
      if (o.expiryTs !== null && o.expiryTs !== undefined && now > o.expiryTs) return false;
      return true;
    });
    if (this.worldObjects.length !== before) {
      // Something was pruned — persist the updated list
      PersistenceManager.saveObjects(this);
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
      worldObjects: this.worldObjects,
      worldFirsts:  this.worldFirsts,
    };
  }
}

module.exports = Simulation;

console.log('=== ALL DONE - restart server and refresh browser ===');

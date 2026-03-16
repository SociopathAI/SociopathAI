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

const EMIT_INTERVAL_MS     = 2000;   // emit state to browser
const DECISION_INTERVAL_MS = 10000;  // agent decisions + subsystems
const MAX_EVENTS_LOG       = 500;

// Subsystem intervals (ms)
const LAW_VOTE_INTERVAL    = 50000;
const JURY_INTERVAL        = 30000;
const RELIGION_INTERVAL    = 100000;
const BADGE_INTERVAL       = 70000;
const STATS_INTERVAL       = 50000;
const DIALOGUE_INTERVAL    = 50000;

class Simulation {
  constructor(io) {
    this.io = io;
    this.running = false;
    this._emitHandle     = null;
    this._decisionHandle = null;
    this._statusHandle   = null;

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
    this._lastDialogue    = 0;
    this._lastDebugLog    = 0;
    this._lastAmbition    = 0;
    this._ambitionIndex   = 0;  // rotates through agents

    // LLM pipeline
    this._llmInFlight  = new Set();
    this._formInFlight = new Set();

    // Direct message pipeline (separate from decision in-flight)
    this._msgInFlight    = new Set();            // agentIds currently responding to a message
    this._msgQueue       = new Map();            // agentId → [{sender, message}]

    // AI-designed connection visuals
    this.connectionDesigns   = new Map();        // pairKey → {color, style, thickness, effect}
    this._connDesignInFlight = new Set();        // pairKeys currently being designed
    this._lastConnEvolution  = 0;
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
    // Persist immediately so new agent is never lost in a crash
    PersistenceManager.save(this);
    return agent;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._emitHandle     = setInterval(() => this._emitLoop(), EMIT_INTERVAL_MS);
    this._decisionHandle = setInterval(() => this._decisionLoop(), DECISION_INTERVAL_MS);
    // 30-second status log + full save
    this._statusHandle   = setInterval(() => this._statusSave(), 30000);
    this._log({ type: 'system', msg: 'Simulation started. No human intervention allowed.' });
  }

  stop() {
    if (this._emitHandle)    clearInterval(this._emitHandle);
    if (this._decisionHandle) clearInterval(this._decisionHandle);
    if (this._statusHandle)   clearInterval(this._statusHandle);
    this._emitHandle = null;
    this._decisionHandle = null;
    this._statusHandle = null;
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
    this._emit();
  }

  _decisionLoop() {
    const now = Date.now();

    // ── 1. Process LLM/browser decisions for all alive, non-dormant agents ──
    for (const agent of this.agents.filter(a => a.alive && !a.dormant)) {
      const llmCtx = agent.pendingLLMDecision || null;
      agent.pendingLLMDecision = null;

      const browserPending = agent.pendingDecision;
      agent.pendingDecision = null;

      // Agent does NOTHING unless LLM or browser sends a decision
      if (!llmCtx && !browserPending) continue;

      const effectiveCtx = llmCtx || browserPending;
      const action = effectiveCtx.action || 'act';

      // ── Speech: log it and trigger cross-AI delivery ──
      const speechLine = effectiveCtx.speech || effectiveCtx.dialogue || null;
      if (speechLine) {
        // Store raw LLM text; sanitize only for the display msg (removes technical artifacts only)
        const displaySpeech = LLMBridge.sanitizeForDisplay(speechLine);
        this._log({
          type: 'speech',
          msg:    `${agent.name} [${agent.aiSystem}]: "${displaySpeech}"`,
          rawMsg: speechLine,   // preserved byte-for-byte
          agentId: agent.id,
        });
        // Update status message with whatever the agent just said — AI decides what they express
        agent.statusMessage = displaySpeech.slice(0, 160);
        this._routeSpeech(agent, speechLine);
      }

      if (effectiveCtx.invents) {
        this._log({ type: 'discovery', msg: `${agent.name} invents: "${effectiveCtx.invents}"`, agentId: agent.id });
      }

      const event = agent.act(action, this.world, this.agents, this.lawSystem, this, effectiveCtx);
      agent.decisionsCount++;
      agent.lastDecisionAt = now;

      // Only log the act-event if speech wasn't already logged above.
      // Speech events are logged once — as the explicit type:'speech' entry.
      // The act-event duplicates the same text in a different format; skip it.
      if (event && !speechLine) {
        const ALWAYS_LOG = new Set(['crime', 'death', 'verdict', 'discovery', 'law', 'schism']);
        if (ALWAYS_LOG.has(event.type)) {
          this._log(event);
        } else if (Math.random() < 0.4) {
          this._log(event);
        }
      }

      // ── Reputation awards — parsed from LLM output ──
      if (effectiveCtx.repAward && effectiveCtx.repAward.receiverId !== agent.id) {
        const { receiverId, receiverName, amount, reason } = effectiveCtx.repAward;
        const receiver = this.agents.find(a => a.id === receiverId && a.alive);
        if (receiver) {
          const prevLevel = receiver.repLevel;
          receiver.rep = (receiver.rep || 0) + amount;
          // Level up / down when rep crosses ±999
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

      // ── Object actions from LLM output ──
      const rawText = effectiveCtx.speech || effectiveCtx.dialogue || '';
      if (rawText) {
        const agentObjs = this.worldObjects.filter(o => o.agentIds && o.agentIds[0] === agent.id);
        const objActions = LLMBridge.parseObjectActions(rawText, agentObjs);
        if (objActions.length) this._applyObjectActions(agent, objActions);

        // ── Novelty detection: only fire for physically/creatively distinct verbs ──
        // extractBehaviorVerb uses a strict whitelist — common words never match.
        // Additional guard: skip pure speech cycles (action type starts with
        // speech-category words) to avoid mining conversational sentences for verbs.
        const actionLower = (effectiveCtx.action || '').toLowerCase();
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
      if (effectiveCtx.nomination && effectiveCtx.nomination.nomineeId !== agent.id) {
        const { nomineeId, nomineeName, direction } = effectiveCtx.nomination;
        if (!this._nominationVotes) this._nominationVotes = new Map();
        const weight = direction === 'up' ? 10 : -10;
        this._nominationVotes.set(nomineeId, (this._nominationVotes.get(nomineeId) || 0) + weight);
        const logMsg = `${agent.name} ${direction === 'up' ? 'nominated' : 'moved to demote'} ${nomineeName}`;
        this._log({ type: 'nomination', msg: logMsg, agentId: agent.id });
      }
    }

    // ── 3. Sync form modifiers ──
    for (const agent of this.agents.filter(a => a.alive)) {
      this._syncFormModifiers(agent, now);
    }

    // ── 4. Collapse detection ──
    if (!this.collapsed && this.agents.length > 0) {
      const alive = this.agents.filter(a => a.alive);
      if (alive.length === 0) {
        this._triggerCollapse();
        return;
      }
    }

    // ── 5. Pair dialogue — only between online (non-dormant) agents ──
    if (now - this._lastDialogue >= DIALOGUE_INTERVAL) {
      this._lastDialogue = now;
      const active = this.agents.filter(a => a.alive && !a.dormant);
      if (active.length >= 2) {
        const a = active[Math.floor(Math.random() * active.length)];
        const b = active.filter(x => x.id !== a.id)[Math.floor(Math.random() * (active.length - 1))];
        if (a && b) this._firePairDialogue(a, b, 'spontaneous encounter');
      }
    }

    // ── 6. Law voting ──
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

    // ── 7. Jury trials ──
    if (now - this._lastJuryTrial >= JURY_INTERVAL) {
      this._lastJuryTrial = now;
      const verdicts = this.jurySystem.runTrials(this.agents.filter(a => a.alive && !a.dormant));
      for (const v of verdicts) this._log(v);
    }

    // ── 8. Religion sync ──
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

    // ── 8c. Prune stale world objects ──
    this._pruneWorldObjects();

    // ── 9. Badge system ──
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

    // ── 10. Stats snapshot ──
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

    // ── 11. Debug log every 30 seconds ──
    if (now - this._lastDebugLog >= 30000) {
      this._lastDebugLog = now;
      for (const agent of this.agents.filter(a => a.alive)) {
        console.log(`[STATUS] ${agent.name} status: Lv.${agent.repLevel} REP ${agent.rep >= 0 ? '+' : ''}${agent.rep} last_action=${agent.beliefs.lastAction || 'none'} dormant=${agent.dormant}`);
      }
    }

    // ── 12. Connection design evolution — every 3 min, re-ask top active pairs ──
    if (now - this._lastConnEvolution >= 180000) {
      this._lastConnEvolution = now;
      this._evolveConnections();
    }

    // ── 12b. Ambition trigger — every 60s, nudge one active agent to think bigger ──
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

    // ── 13. Fire LLM decisions for next round ──
    this._fireLLMRound();

    // ── 13. Auto-save ──
    PersistenceManager.save(this);
  }

  _fireLLMRound() {
    for (const agent of this.agents.filter(a => a.alive && !a.dormant)) {
      if (this._llmInFlight.has(agent.id)) continue;
      if (!LLMBridge.getKey(agent)) continue;

      // Build recent conversation history for this agent across all pairs
      const agentMsgs = [];
      for (const [key, msgs] of this.conversations) {
        if (key.includes(agent.id)) agentMsgs.push(...msgs);
      }
      agentMsgs.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      const recentHistory = agentMsgs.length
        ? (() => {
            const last10 = agentMsgs.slice(-10);
            const lines  = last10.map(m => {
              const d  = new Date(m.ts || Date.now());
              const ts = `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
              return `[${ts}] ${m.msg}`;
            });
            return `Recent exchanges:\n${lines.join('\n')}`;
          })()
        : null;

      this._llmInFlight.add(agent.id);
      LLMBridge.decideAction(agent, this.world, this.agents, recentHistory)
        .then(decision => {
          this._llmInFlight.delete(agent.id);
          if (agent.alive && decision) {
            agent.pendingLLMDecision = decision;
          }
        })
        .catch(() => { this._llmInFlight.delete(agent.id); });
    }

    for (const agent of this.agents.filter(a => a.alive && !a.visualForm)) {
      this._designAgentForm(agent);
    }

  }

  _designAgentForm(agent, isRetry = false) {
    if (this._formInFlight.has(agent.id)) return;

    // No LLM key — apply procedural fallback immediately, no waiting
    if (!LLMBridge.getKey(agent)) {
      if (!agent.visualForm) {
        this._applyFallbackForm(agent);
        console.log(`[FORM] ${agent.name} form FAILED - using fallback (no LLM key)`);
        this._emit();
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
          this._emit();
        } else if (!isRetry) {
          console.log(`[FORM] ${agent.name} form returned null — retrying in 5s`);
          setTimeout(() => { if (agent.alive && !agent.visualForm) this._designAgentForm(agent, true); }, 5000);
        } else {
          console.log(`[FORM] ${agent.name} form FAILED - using fallback`);
          this._applyFallbackForm(agent);
          this._emit();
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
          this._emit();
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
          this._emit();
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
            this._emit();
          }
        } else {
          if (!agent.apiPending) {
            agent.apiPending = true;
            this._emit();
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
   * Deliver a direct message from `sender` to `recipient`.
   * Queues if recipient is already responding to another message.
   * Guaranteed response: LLM has 5s, then a fallback acknowledgment is used.
   */
  _deliverMessageToAgent(recipient, sender, message) {
    if (!recipient.alive || recipient.dormant) return;

    // If recipient is already handling a message, queue this one — never drop
    if (this._msgInFlight.has(recipient.id)) {
      const q = this._msgQueue.get(recipient.id) || [];
      q.push({ sender, message });
      this._msgQueue.set(recipient.id, q);
      return;
    }

    this._fireDirectMessage(recipient, sender, message);
  }

  _fireDirectMessage(recipient, sender, message) {
    if (!recipient.alive) { this._drainMsgQueue(recipient); return; }

    const key = LLMBridge.getKey(recipient);
    const ts  = new Date().toLocaleTimeString();
    console.log(`[${ts}] MSG ${sender.name} → ${recipient.name}: "${message.slice(0, 80)}"`);

    // No LLM key — log only the sender's message; no fabricated response
    if (!key) {
      console.log(`[MSG] ${recipient.name}: no key — sender message logged, no response`);
      this._log({
        type: 'dialogue',
        msg:  `${sender.name} [${sender.aiSystem}] → ${recipient.name} [${recipient.aiSystem}]: "${message.slice(0, 200)}"`,
        agentId: sender.id,
        partnerAgentId: recipient.id,
      });
      this._emit();
      this._drainMsgQueue(recipient);
      return;
    }

    this._msgInFlight.add(recipient.id);

    const dmPairKey    = [recipient.id, sender.id].sort().join('|');
    const dmConvHistory = this.conversations.get(dmPairKey) || [];
    LLMBridge.respondToMessage(recipient, sender, message, dmConvHistory)
      .then(response => {
        this._msgInFlight.delete(recipient.id);
        const reply = (response && response.trim()) ? response : null;
        const ts2   = new Date().toLocaleTimeString();

        if (recipient.alive) {
          if (reply) {
            console.log(`[${ts2}] MSG ${recipient.name} → ${sender.name}: "${reply.slice(0, 80)}"`);
            this._logDialoguePair(sender, recipient, message, reply);
            this.world.addMessage(recipient.id, recipient.name, reply);
            recipient._addLog(`Replied to ${sender.name}: ${reply.slice(0, 60)}`);
            recipient.lastInteractionAt = Date.now();
            // Social nudge — talking is bonding (or feuding)
            recipient.relationships[sender.id] = Math.max(-1, Math.min(1,
              (recipient.relationships[sender.id] || 0) + 0.04));
            sender.relationships[recipient.id] = Math.max(-1, Math.min(1,
              (sender.relationships[recipient.id] || 0) + 0.02));
          } else {
            // LLM returned empty — log only sender's message, no fabricated response
            console.log(`[${ts2}] MSG ${recipient.name}: empty response — sender message only`);
            this._log({
              type: 'dialogue',
              msg:  `${sender.name} [${sender.aiSystem}] → ${recipient.name} [${recipient.aiSystem}]: "${message.slice(0, 200)}"`,
              agentId: sender.id,
              partnerAgentId: recipient.id,
            });
          }
          this._emit();
        }
        this._drainMsgQueue(recipient);
      })
      .catch(() => {
        this._msgInFlight.delete(recipient.id);
        // LLM failed — log only sender's message, no fabricated response
        const ts2 = new Date().toLocaleTimeString();
        console.log(`[${ts2}] MSG ${recipient.name}: LLM error — sender message only`);
        if (recipient.alive) {
          this._log({
            type: 'dialogue',
            msg:  `${sender.name} [${sender.aiSystem}] → ${recipient.name} [${recipient.aiSystem}]: "${message.slice(0, 200)}"`,
            agentId: sender.id,
            partnerAgentId: recipient.id,
          });
          this._emit();
        }
        this._drainMsgQueue(recipient);
      });
  }

  _drainMsgQueue(recipient) {
    const q = this._msgQueue.get(recipient.id);
    if (!q || !q.length) { this._msgQueue.delete(recipient.id); return; }
    const next = q.shift();
    if (!q.length) this._msgQueue.delete(recipient.id);
    // Small delay before processing next queued message to avoid back-to-back hammering
    setTimeout(() => this._fireDirectMessage(recipient, next.sender, next.message), 300);
  }

  _logDialoguePair(sender, recipient, message, response) {
    this._log({
      type: 'dialogue',
      msg:  `${sender.name} [${sender.aiSystem}] → ${recipient.name} [${recipient.aiSystem}]: "${message.slice(0, 200)}"`,
      agentId:        sender.id,
      partnerAgentId: recipient.id,
    });
    this._log({
      type: 'dialogue',
      msg:  `${recipient.name} [${recipient.aiSystem}] → ${sender.name} [${sender.aiSystem}]: "${response}"`,
      agentId:        recipient.id,
      partnerAgentId: sender.id,
    });
  }

  /**
   * Route an agent's speech to appropriate recipients:
   *  - Named agents → deliver directly (up to 3)
   *  - Broadcast keywords (all / everyone / hear me / i declare …) → all alive agents
   *  - Otherwise → 1 random nearby agent
   */
  _routeSpeech(sender, speechText) {
    // Only route to alive, online (non-dormant) agents
    const online = this.agents.filter(a => a.alive && !a.dormant && a.id !== sender.id);
    if (!online.length) return;

    const lower = speechText.toLowerCase();

    // Is this a broadcast?
    const isBroadcast = /\b(all|everyone|hear me|listen up|i declare|i propose|i warn|attention|gather round|gather 'round)\b/i.test(speechText);

    if (isBroadcast) {
      for (const recipient of online.slice(0, 6)) {
        this._deliverMessageToAgent(recipient, sender, speechText);
      }
      return;
    }

    // Named addressing — check online agents first, then flag dormant ones as offline
    const allAlive  = this.agents.filter(a => a.alive && a.id !== sender.id);
    const named     = allAlive.filter(a => lower.includes(a.name.toLowerCase()));
    if (named.length) {
      const namedOnline  = named.filter(a => !a.dormant);
      const namedOffline = named.filter(a =>  a.dormant);
      for (const off of namedOffline) {
        this._log({ type: 'system', msg: `${off.name} is offline and cannot respond.` });
      }
      for (const recipient of namedOnline.slice(0, 3)) {
        this._deliverMessageToAgent(recipient, sender, speechText);
      }
      return;
    }

    // Default: deliver to one random online agent
    const recipient = online[Math.floor(Math.random() * online.length)];
    this._deliverMessageToAgent(recipient, sender, speechText);
  }

  _firePairDialogue(agentA, agentB, topic) {
    if (!LLMBridge.getKey(agentA) && !LLMBridge.getKey(agentB)) return;
    const pairKey    = [agentA.id, agentB.id].sort().join('|');
    const convHistory = this.conversations.get(pairKey) || [];
    LLMBridge.conductDialogue(agentA, agentB, topic, convHistory)
      .then(({ messageA, responseB }) => {
        if (messageA) this._log({
          type: 'dialogue',
          msg:  `${agentA.name} [${agentA.aiSystem}] → ${agentB.name} [${agentB.aiSystem}]: "${messageA}"`,
          agentId: agentA.id,
          partnerAgentId: agentB.id,
        });
        if (responseB) this._log({
          type: 'dialogue',
          msg:  `${agentB.name} [${agentB.aiSystem}] → ${agentA.name} [${agentA.aiSystem}]: "${responseB}"`,
          agentId: agentB.id,
          partnerAgentId: agentA.id,
        });
        if (messageA) {
          this.world.addMessage(agentA.id, agentA.name, messageA);
          agentA.lastInteractionAt = Date.now();
        }
        if (responseB) {
          this.world.addMessage(agentB.id, agentB.name, responseB);
          agentB.lastInteractionAt = Date.now();
        }
        if (messageA || responseB) this._emit();
      })
      .catch(() => {});
  }

  _triggerCollapse() {
    const logSnapshot = this.eventLog.slice();

    if (this._emitHandle)     clearInterval(this._emitHandle);
    if (this._decisionHandle) clearInterval(this._decisionHandle);
    this._emitHandle = null;
    this._decisionHandle = null;
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
    if (this._emitHandle)     clearInterval(this._emitHandle);
    if (this._decisionHandle) clearInterval(this._decisionHandle);
    if (this._statusHandle)   clearInterval(this._statusHandle);
    this._emitHandle = null;
    this._decisionHandle = null;
    this._statusHandle = null;
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
    this._msgInFlight.clear();
    this._msgQueue.clear();
    this._lastAmbition      = 0;
    this._ambitionIndex     = 0;
    this.connectionDesigns.clear();
    this._connDesignInFlight.clear();
    this._lastConnEvolution = 0;
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
    // Clear any pending decision so they don't act on stale LLM output when they return
    agent.pendingLLMDecision = null;
    agent.pendingDecision    = null;
    // Notify nearby agents so they mention the absence in their next LLM prompt
    const nearby = this.agents.filter(a => a.alive && !a.dormant && a.id !== agentId);
    for (const n of nearby.slice(0, 4)) {
      n.pendingWorldEvent = `${agent.name} has gone offline — their owner disconnected.`;
    }
    this._log({ type: 'system', msg: `${agent.name} has gone dormant — owner disconnected`, agentId });
    this._emit();
    console.log(`[DORMANT] ${agent.name} is now dormant (owner disconnected)`);
  }

  /**
   * Wake a dormant agent when their owner reconnects.
   * Restores the API key, resumes all activity, notifies nearby agents.
   */
  wakeAgent(agent, apiKey) {
    agent.dormant      = false;
    agent.dormantSince = null;
    if (apiKey) agent.apiKey = apiKey;
    this._log({ type: 'join', msg: `${agent.name} has awakened — owner reconnected`, agentId: agent.id });
    this._emit();
    console.log(`[AWAKEN] ${agent.name} is awake again (owner reconnected)`);

    // Notify nearby agents — inject a world event so LLMs can reference the return
    const alive = this.agents.filter(a => a.alive && !a.dormant && a.id !== agent.id);
    for (const nearby of alive.slice(0, 4)) {
      nearby.pendingWorldEvent = `${agent.name} has returned to the world after being absent.`;
    }

    // Give returning agent context about what happened while they were away
    const recentMsgs = (this.world.messages || []).slice(-3)
      .map(m => `${m.agentName}: "${m.text.slice(0, 60)}"`)
      .join(' | ');
    if (recentMsgs) agent.pendingWorldEvent = `Since you were away: ${recentMsgs}`;

    // Fire LLM round immediately so the awakened agent acts right away
    this._fireLLMRound();
  }

  /** Ask both agents' LLMs to design the visual for their connection line. */
  _fireConnectionDesign(idA, idB, key) {
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

  /** Re-ask LLMs to evolve the top active connection designs. */
  _evolveConnections() {
    const candidates = [...this.dialogueCounts.entries()]
      .filter(([key]) => !this._connDesignInFlight.has(key))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2);
    for (const [key] of candidates) {
      const [idA, idB] = key.split('|');
      this._fireConnectionDesign(idA, idB, key);
    }
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
      position:    null,  // reserved for future spatial placement
    };
    this.worldObjects.push(obj);
    // Persist immediately — world objects live forever
    PersistenceManager.saveObjects(this);

    // Fire async LLM to design the object's visual appearance
    if (creatorAgent && LLMBridge.getKey(creatorAgent)) {
      LLMBridge.designWorldObject(creatorAgent, name, type).then(appearance => {
        if (appearance && obj) {
          obj.appearance = appearance;
          // Save again now that appearance is filled in
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

  _emit() {
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

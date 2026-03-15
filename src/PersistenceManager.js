// PersistenceManager: secure key fingerprinting + cumulative JSON persistence
// Raw API keys are NEVER written to disk — only SHA-256 hash + random salt
//
// Data policy: ALL data files are CUMULATIVE — saves always merge with what is
// already on disk, never replace or truncate.  The only exception is world.json
// (live sim state), which is always overwritten with the current snapshot.
'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const DATA_DIR            = path.join(__dirname, '..', 'data');
const AGENTS_FILE         = path.join(DATA_DIR, 'agents.json');
const WORLD_FILE          = path.join(DATA_DIR, 'world.json');
const OBJECTS_FILE        = path.join(DATA_DIR, 'objects.json');
const CONVERSATIONS_FILE  = path.join(DATA_DIR, 'conversations.json');
const EVENTS_FILE         = path.join(DATA_DIR, 'events.json');

// Events on disk are NEVER trimmed — append-only forever.
// (In-memory eventLog is still capped at MAX_EVENTS_LOG in Simulation.js for RAM,
//  but the on-disk history always grows and is never truncated.)

// ─── Key fingerprinting ────────────────────────────────────────────────────────

/** Returns { salt, hash }. Only these are persisted — never the raw key. */
function hashKey(apiKey) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHash('sha256').update(salt + apiKey).digest('hex');
  return { salt, hash };
}

/** Returns true if candidateKey matches the stored salt+hash. */
function verifyKey(candidateKey, salt, hash) {
  if (!candidateKey || !salt || !hash) return false;
  const check = crypto.createHash('sha256').update(salt + candidateKey).digest('hex');
  return check === hash;
}

/**
 * Find the first agent whose stored fingerprint matches the candidate key.
 * Returns the live Agent object (with all methods) or null.
 */
function findAgentByKey(candidateKey, agents) {
  for (const a of agents) {
    if (a.keyHash && a.keySalt && verifyKey(candidateKey, a.keySalt, a.keyHash)) {
      return a;
    }
  }
  return null;
}

// ─── Low-level helpers ─────────────────────────────────────────────────────────

function _ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** Write data atomically: write to .tmp then rename over destination. */
function _writeAtomic(filePath, payload) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, payload, 'utf8');
  fs.renameSync(tmp, filePath);
}

/** Safely read + parse a JSON file; returns null on any error. */
function _readJSON(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// ─── Serialization helpers ────────────────────────────────────────────────────

function _serializeAgent(a) {
  return {
    id:                a.id,
    name:              a.name,
    nickname:          a.nickname,
    aiSystem:          a.aiSystem,
    alive:             a.alive,
    energy:            a.energy,
    food:              a.food,
    material:          a.material,
    traits:            { ...a.traits },
    beliefs:           { ...a.beliefs, criminalRecord: JSON.parse(JSON.stringify(a.beliefs.criminalRecord || [])) },
    relationships:     { ...a.relationships },
    reputation:        a.reputation,
    educationNotes:    a.educationNotes,
    deployedAt:        a.deployedAt,
    stats:             { ...a.stats },
    points:            a.points || 0,
    badges:            JSON.parse(JSON.stringify(a.badges || [])),
    log:               [...(a.log || [])],
    symbol:            a.symbol,
    lastActions:       [...(a.lastActions || [])],
    lastInteractionAt: a.lastInteractionAt || 0,
    zeroFoodSince:     a.zeroFoodSince     || null,
    lastDecisionAt:    a.lastDecisionAt    || 0,
    lastPassiveAt:     a.lastPassiveAt     || null,
    decisionsCount:    a.decisionsCount    || 0,
    deathCause:        a.deathCause,
    deathContext:      a.deathContext,
    killedBy:          a.killedBy,
    deathTs:           a.deathTs,
    // Key fingerprint only — raw key is NEVER persisted
    keyHash:           a.keyHash   || null,
    keySalt:           a.keySalt   || null,
    isTestBot:         a.isTestBot || false,
    // Visual form
    visualForm:        a.visualForm   ? JSON.parse(JSON.stringify(a.visualForm))   : null,
    formModifiers:     JSON.parse(JSON.stringify(a.formModifiers || [])),
    formSnapshot:      a.formSnapshot ? JSON.parse(JSON.stringify(a.formSnapshot)) : null,
  };
}

// ─── Save agents + world snapshot ─────────────────────────────────────────────
// agents.json: merged — existing agents on disk are kept; in-memory updates win
//              for agents we know about; agents only on disk (shouldn't happen)
//              are preserved.
// world.json:  always replaced with the current snapshot (live state only).

function save(sim) {
  try {
    _ensureDataDir();

    // ── Agents: merge disk + memory ──────────────────────────────────────────
    const diskAgentFile = _readJSON(AGENTS_FILE) || {};
    const diskAgents    = diskAgentFile.agents || [];
    const diskNames     = diskAgentFile.usedNames || [];

    // Build a map from disk agents (by id)
    const diskMap = new Map(diskAgents.map(a => [a.id, a]));

    // In-memory agents override disk (they are more up to date)
    const memMap  = new Map(sim.agents.map(a => [a.id, _serializeAgent(a)]));

    // Merge: start from disk set, overwrite with memory
    for (const [id, a] of memMap) diskMap.set(id, a);

    // Build merged usedNames (union of disk + memory)
    const usedNamesSet = new Set([
      ...diskNames,
      ...sim.agents.map(a => a.name.toLowerCase()),
    ]);

    const agentsPayload = JSON.stringify({
      agents:    [...diskMap.values()],
      usedNames: [...usedNamesSet],
    });

    // ── World: always overwrite (it is a live snapshot) ───────────────────────
    const worldPayload = JSON.stringify({
      world: {
        startedAt:   sim.world.startedAt,
        discoveries: sim.world.discoveries,
        messages:    sim.world.messages,
        structures:  sim.world.structures,
      },
      laws: {
        laws:        sim.lawSystem.laws,
        proposals:   sim.lawSystem.proposals,
        voteHistory: sim.lawSystem.voteHistory || [],
      },
      jury: {
        cases:    sim.jurySystem.cases,
        verdicts: sim.jurySystem.verdicts,
      },
      religion: {
        religions: sim.religionSystem.religions,
        schisms:   sim.religionSystem.schisms,
      },
      badges: {
        awarded:   sim.badgeSystem.awarded,
        proposals: sim.badgeSystem.proposals,
        triggered: [...sim.badgeSystem._triggered],
      },
      statsHistory: sim.statsHistory,
      categories:   sim.categoryRegistry.getAll(),
      civManager: {
        archive:       sim.civManager.archive,
        currentNumber: sim.civManager.currentNumber,
      },
      collapsed:        sim.collapsed,
      worldFirsts:      sim.worldFirsts      || [],
      seenActionVerbs:  [...(sim._seenActionVerbs || [])],
    });

    _writeAtomic(AGENTS_FILE, agentsPayload);
    _writeAtomic(WORLD_FILE, worldPayload);
  } catch (err) {
    console.error('[Persistence] save failed:', err.message);
  }
}

// ─── Save world objects ────────────────────────────────────────────────────────
// objects.json: merged — objects on disk whose ids are not in memory are kept
//               (they may have been pruned locally but we preserve history).
//               Objects in memory win (more up to date).

function saveObjects(sim) {
  try {
    _ensureDataDir();

    const diskFile = _readJSON(OBJECTS_FILE) || {};
    const diskObjs = diskFile.worldObjects || [];
    const diskMap  = new Map(diskObjs.map(o => [o.id, o]));

    // In-memory objects override disk
    for (const o of (sim.worldObjects || [])) {
      diskMap.set(o.id, {
        id:          o.id,
        type:        o.type,
        name:        o.name,
        desc:        o.desc,
        creatorId:   o.creatorId   || null,
        creatorName: o.creatorName || null,
        agentIds:    o.agentIds    || [],
        spawnTs:     o.spawnTs,
        expiryTs:    o.expiryTs    || null,
        appearance:  o.appearance  || null,
        position:    o.position    || null,
      });
    }

    _writeAtomic(OBJECTS_FILE, JSON.stringify({
      worldObjects:      [...diskMap.values()],
      worldObjectNextId: sim._nextWOId || 1,
    }));
  } catch (err) {
    console.error('[Persistence] saveObjects failed:', err.message);
  }
}

// ─── Save conversations ────────────────────────────────────────────────────────
// conversations.json: CUMULATIVE — disk conversations are kept; new messages
//                     (by timestamp) are appended per pair.

function saveConversations(sim) {
  try {
    _ensureDataDir();

    // Load existing from disk
    const diskFile = _readJSON(CONVERSATIONS_FILE) || {};
    const existingMap = new Map();
    for (const { key, msgs } of (diskFile.conversations || [])) {
      if (key) existingMap.set(key, msgs || []);
    }

    // Merge in-memory conversations: append messages newer than what's on disk
    for (const [key, msgs] of (sim.conversations || new Map())) {
      if (!existingMap.has(key)) {
        existingMap.set(key, msgs);
      } else {
        const existing    = existingMap.get(key);
        const lastDiskTs  = existing.length ? existing[existing.length - 1].ts : 0;
        const newMsgs     = msgs.filter(m => m.ts > lastDiskTs);
        if (newMsgs.length) existingMap.set(key, [...existing, ...newMsgs]);
      }
    }

    const convArr = [];
    for (const [key, msgs] of existingMap) convArr.push({ key, msgs });
    _writeAtomic(CONVERSATIONS_FILE, JSON.stringify({ conversations: convArr }));
  } catch (err) {
    console.error('[Persistence] saveConversations failed:', err.message);
  }
}

// ─── Save event log ────────────────────────────────────────────────────────────
// events.json: CUMULATIVE — never truncates disk history.
//   - Reads existing events from disk
//   - Appends any in-memory events with ts > last disk event ts
//   - All events kept forever — no trimming

function saveEvents(sim) {
  try {
    _ensureDataDir();

    // Load what's currently on disk (full history)
    const diskFile   = _readJSON(EVENTS_FILE) || {};
    const onDisk     = diskFile.eventLog || [];

    // Find the timestamp of the newest disk event to avoid duplicating
    const lastDiskTs = onDisk.length ? onDisk[onDisk.length - 1].ts : 0;

    // New events: anything in memory that came after the last disk event
    const newEvents  = (sim.eventLog || []).filter(e => e.ts > lastDiskTs);

    // Never trim — append-only forever
    _writeAtomic(EVENTS_FILE, JSON.stringify({ eventLog: [...onDisk, ...newEvents] }));
  } catch (err) {
    console.error('[Persistence] saveEvents failed:', err.message);
  }
}

// ─── Load ─────────────────────────────────────────────────────────────────────

function load() {
  if (!fs.existsSync(AGENTS_FILE) || !fs.existsSync(WORLD_FILE)) return null;
  try {
    const agentData = _readJSON(AGENTS_FILE);
    const worldData = _readJSON(WORLD_FILE);
    if (!agentData || !worldData) return null;

    const objectsData       = _readJSON(OBJECTS_FILE);
    const conversationsData = _readJSON(CONVERSATIONS_FILE);
    const eventsData        = _readJSON(EVENTS_FILE);

    return { agentData, worldData, objectsData, conversationsData, eventsData };
  } catch (err) {
    console.error('[Persistence] Load failed:', err.message);
    return null;
  }
}

// ─── Paginated event page (for infinite scroll) ───────────────────────────────
// Returns { events, hasMore }.
// events: up to `limit` events with ts < `before`, sorted newest-first.
// If agentName given, filters to events that mention that agent.

function loadEventPage({ before = null, limit = 50, agentName = null } = {}) {
  const diskFile = _readJSON(EVENTS_FILE) || {};
  let events = diskFile.eventLog || [];

  // Filter by agent name if given — first try exact id match, then msg-text fallback
  if (agentName) {
    const nameLower = agentName.toLowerCase().trim();
    // Look up the agent's id for more accurate primary match
    const allAgents = _readJSON(AGENTS_FILE)?.agents || [];
    const agentId   = allAgents.find(a => (a.name || '').toLowerCase() === nameLower)?.id || null;

    events = events.filter(e => {
      if (agentId && (e.agentId === agentId || e.partnerAgentId === agentId)) return true;
      return (e.msg || '').toLowerCase().includes(nameLower);
    });
  }

  // Apply the `before` cutoff (exclusive — events strictly older than this ts)
  if (before !== null) {
    const cut = Number(before);
    events = events.filter(e => (e.ts || 0) < cut);
  }

  // events is in ascending (oldest-first) order; take last `limit` = most recent of the older set
  const total  = events.length;
  const hasMore = total > limit;
  // Slice, then reverse so result is newest-first for client appending
  const page   = events.slice(-limit).reverse();

  return { events: page, hasMore };
}

// ─── Data integrity check ─────────────────────────────────────────────────────
// Returns array of { name, exists, count, size, corrupt }
// A file is "corrupt" if it exists with >20 bytes of content but parses to 0 records.

function integrityCheck() {
  const checks = [
    { name: 'agents',        file: AGENTS_FILE,        key: 'agents'        },
    { name: 'events',        file: EVENTS_FILE,        key: 'eventLog'      },
    { name: 'conversations', file: CONVERSATIONS_FILE, key: 'conversations' },
    { name: 'objects',       file: OBJECTS_FILE,       key: 'worldObjects'  },
  ];
  return checks.map(c => {
    const exists = fs.existsSync(c.file);
    const size   = exists ? fs.statSync(c.file).size : 0;
    const data   = _readJSON(c.file);
    const count  = data?.[c.key]?.length || 0;
    // Corrupt = file present with real content but no records parseable
    const corrupt = exists && size > 50 && count === 0;
    return { name: c.name, exists, count, size, corrupt };
  });
}

// ─── Load history filtered by agent name ──────────────────────────────────────
// Used by /api/history/events and /api/history/conversations endpoints.

function loadHistoryByAgent(agentName) {
  const nameLower = (agentName || '').toLowerCase().trim();
  if (!nameLower) return { agent: null, events: [], conversations: [] };

  const allAgents = _readJSON(AGENTS_FILE)?.agents || [];
  const agent     = allAgents.find(a => (a.name || '').toLowerCase() === nameLower) || null;
  const agentId   = agent?.id || null;

  // Events: match by agentId (primary) or name in message text (fallback)
  const allEvents  = _readJSON(EVENTS_FILE)?.eventLog || [];
  const agentEvents = allEvents.filter(e => {
    if (agentId && e.agentId === agentId) return true;
    if (agentId && e.partnerAgentId === agentId) return true;
    return (e.msg || '').toLowerCase().includes(nameLower);
  });

  // Conversations: match pair key or any message from/to this agent
  const allConvs     = _readJSON(CONVERSATIONS_FILE)?.conversations || [];
  const agentConvs   = allConvs.filter(c => {
    if (!c.key) return false;
    const parts = c.key.split('|');
    return parts.some(p => p.toLowerCase() === nameLower);
  });

  return { agent, events: agentEvents, conversations: agentConvs };
}

// ─── Full history read (for /api/history endpoint) ────────────────────────────

function loadFullHistory() {
  return {
    agents:        (_readJSON(AGENTS_FILE)        ?.agents        || []),
    events:        (_readJSON(EVENTS_FILE)         ?.eventLog      || []),
    conversations: (_readJSON(CONVERSATIONS_FILE)  ?.conversations || []),
    objects:       (_readJSON(OBJECTS_FILE)        ?.worldObjects  || []),
  };
}

// ─── Count what's on disk (for startup log) ───────────────────────────────────

function diskCounts() {
  return {
    agents:        (_readJSON(AGENTS_FILE)        ?.agents        ?.length || 0),
    events:        (_readJSON(EVENTS_FILE)         ?.eventLog      ?.length || 0),
    conversations: (_readJSON(CONVERSATIONS_FILE)  ?.conversations ?.length || 0),
    objects:       (_readJSON(OBJECTS_FILE)        ?.worldObjects  ?.length || 0),
  };
}

module.exports = {
  hashKey, verifyKey, findAgentByKey,
  save, saveObjects, saveConversations, saveEvents,
  load, loadFullHistory, diskCounts,
  integrityCheck, loadHistoryByAgent, loadEventPage,
};

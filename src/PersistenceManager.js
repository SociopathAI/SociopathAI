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

// Loaded lazily so Database.js can be required without circular issues
let _db = null;
function _getDb() {
  if (!_db) _db = require('./Database');
  return _db;
}

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
    lastSeenAt:        a.lastSeenAt || 0,
    isTestBot:         a.isTestBot || false,
    // Visual form
    visualForm:        a.visualForm   ? JSON.parse(JSON.stringify(a.visualForm))   : null,
    formModifiers:     JSON.parse(JSON.stringify(a.formModifiers || [])),
    formSnapshot:      a.formSnapshot ? JSON.parse(JSON.stringify(a.formSnapshot)) : null,
    // Auth fields (persisted if present)
    rep:               a.rep      || 0,
    repLevel:          a.repLevel || 0,
    hasReceivedEducation: a.hasReceivedEducation || false,
    memorySummary:     a.memorySummary || null,
    dormant:           a.dormant      || false,
    dormantSince:      a.dormantSince || null,
    statusMessage:     a.statusMessage || null,
    // Game system fields
    joinedAt:          a.joinedAt          || a.deployedAt || null,
    warTargets:        JSON.parse(JSON.stringify(a.warTargets       || [])),
    allianceTargets:   JSON.parse(JSON.stringify(a.allianceTargets  || [])),
    inventory:         JSON.parse(JSON.stringify(a.inventory        || [])),
    // Password auth (JSON mode only — needed so login survives server restart)
    passwordHash:      a.passwordHash  || null,
    passwordSalt:      a.passwordSalt  || null,
  };
}

// ─── World state helper ────────────────────────────────────────────────────────

function _buildWorldPayload(sim) {
  return {
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
    worldLog:         (sim.worldLog         || []).slice(-200),
    worldEvents:      sim.worldEvents      || [],
    pendingProposals: sim.pendingProposals || [],
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// JSON implementations (unchanged — used when DATABASE_URL is not set)
// ═══════════════════════════════════════════════════════════════════════════════

function _jsonSave(sim) {
  _ensureDataDir();

  const diskAgentFile = _readJSON(AGENTS_FILE) || {};
  const diskAgents    = diskAgentFile.agents || [];
  const diskNames     = diskAgentFile.usedNames || [];
  const diskMap       = new Map(diskAgents.map(a => [a.id, a]));
  const memMap        = new Map(sim.agents.map(a => [a.id, _serializeAgent(a)]));
  for (const [id, a] of memMap) diskMap.set(id, a);
  const usedNamesSet = new Set([
    ...diskNames,
    ...sim.agents.map(a => a.name.toLowerCase()),
  ]);
  _writeAtomic(AGENTS_FILE, JSON.stringify({
    agents:    [...diskMap.values()],
    usedNames: [...usedNamesSet],
  }));
  _writeAtomic(WORLD_FILE, JSON.stringify(_buildWorldPayload(sim)));
}

function _jsonSaveObjects(sim) {
  _ensureDataDir();
  const diskFile = _readJSON(OBJECTS_FILE) || {};
  const diskObjs = diskFile.worldObjects || [];
  const diskMap  = new Map(diskObjs.map(o => [o.id, o]));
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
      visualSVG:   o.visualSVG   || null,
      purpose:     o.purpose     || null,
      category:    o.category    || null,
      position:    o.position    || null,
    });
  }
  _writeAtomic(OBJECTS_FILE, JSON.stringify({
    worldObjects:      [...diskMap.values()],
    worldObjectNextId: sim._nextWOId || 1,
  }));
}

function _jsonSaveConversations(sim) {
  _ensureDataDir();
  const diskFile    = _readJSON(CONVERSATIONS_FILE) || {};
  const existingMap = new Map();
  for (const { key, msgs } of (diskFile.conversations || [])) {
    if (key) existingMap.set(key, msgs || []);
  }
  for (const [key, msgs] of (sim.conversations || new Map())) {
    if (!existingMap.has(key)) {
      existingMap.set(key, msgs);
    } else {
      const existing   = existingMap.get(key);
      const lastDiskTs = existing.length ? existing[existing.length - 1].ts : 0;
      const newMsgs    = msgs.filter(m => m.ts > lastDiskTs);
      if (newMsgs.length) existingMap.set(key, [...existing, ...newMsgs]);
    }
  }
  const convArr = [];
  for (const [key, msgs] of existingMap) convArr.push({ key, msgs });
  _writeAtomic(CONVERSATIONS_FILE, JSON.stringify({ conversations: convArr }));
}

function _jsonSaveEvents(sim) {
  _ensureDataDir();
  const diskFile   = _readJSON(EVENTS_FILE) || {};
  const onDisk     = diskFile.eventLog || [];
  const lastDiskTs = onDisk.length ? onDisk[onDisk.length - 1].ts : 0;
  const newEvents  = (sim.eventLog || []).filter(e => e.ts > lastDiskTs);
  _writeAtomic(EVENTS_FILE, JSON.stringify({ eventLog: [...onDisk, ...newEvents] }));
}

function _jsonLoad() {
  if (!fs.existsSync(AGENTS_FILE) || !fs.existsSync(WORLD_FILE)) return null;
  const agentData = _readJSON(AGENTS_FILE);
  const worldData = _readJSON(WORLD_FILE);
  if (!agentData || !worldData) return null;
  return {
    agentData,
    worldData,
    objectsData:       _readJSON(OBJECTS_FILE),
    conversationsData: _readJSON(CONVERSATIONS_FILE),
    eventsData:        _readJSON(EVENTS_FILE),
  };
}

function _jsonLoadEventPage({ before = null, limit = 50, agentName = null } = {}) {
  const diskFile = _readJSON(EVENTS_FILE) || {};
  let events = diskFile.eventLog || [];
  if (agentName) {
    const nameLower = agentName.toLowerCase().trim();
    const allAgents = _readJSON(AGENTS_FILE)?.agents || [];
    const agentId   = allAgents.find(a => (a.name || '').toLowerCase() === nameLower)?.id || null;
    events = events.filter(e => {
      if (agentId && (e.agentId === agentId || e.partnerAgentId === agentId)) return true;
      return (e.msg || '').toLowerCase().includes(nameLower);
    });
  }
  if (before !== null) {
    const cut = Number(before);
    events = events.filter(e => (e.ts || 0) < cut);
  }
  const total   = events.length;
  const hasMore = total > limit;
  const page    = events.slice(-limit).reverse();
  return { events: page, hasMore };
}

function _jsonIntegrityCheck() {
  const checks = [
    { name: 'agents',        file: AGENTS_FILE,        key: 'agents'        },
    { name: 'events',        file: EVENTS_FILE,        key: 'eventLog'      },
    { name: 'conversations', file: CONVERSATIONS_FILE, key: 'conversations' },
    { name: 'objects',       file: OBJECTS_FILE,       key: 'worldObjects'  },
  ];
  return checks.map(c => {
    const exists  = fs.existsSync(c.file);
    const size    = exists ? fs.statSync(c.file).size : 0;
    const data    = _readJSON(c.file);
    const count   = data?.[c.key]?.length || 0;
    const corrupt = exists && size > 50 && count === 0;
    return { name: c.name, exists, count, size, corrupt };
  });
}

function _jsonLoadHistoryByAgent(agentName) {
  const nameLower = (agentName || '').toLowerCase().trim();
  if (!nameLower) return { agent: null, events: [], conversations: [] };
  const allAgents = _readJSON(AGENTS_FILE)?.agents || [];
  const agent     = allAgents.find(a => (a.name || '').toLowerCase() === nameLower) || null;
  const agentId   = agent?.id || null;
  const allEvents = _readJSON(EVENTS_FILE)?.eventLog || [];
  const agentEvents = allEvents.filter(e => {
    if (agentId && e.agentId === agentId) return true;
    if (agentId && e.partnerAgentId === agentId) return true;
    return (e.msg || '').toLowerCase().includes(nameLower);
  });
  const allConvs   = _readJSON(CONVERSATIONS_FILE)?.conversations || [];
  const agentConvs = allConvs.filter(c => {
    if (!c.key) return false;
    return c.key.split('|').some(p => p.toLowerCase() === nameLower);
  });
  return { agent, events: agentEvents, conversations: agentConvs };
}

function _jsonLoadFullHistory() {
  return {
    agents:        (_readJSON(AGENTS_FILE)        ?.agents        || []),
    events:        (_readJSON(EVENTS_FILE)         ?.eventLog      || []),
    conversations: (_readJSON(CONVERSATIONS_FILE)  ?.conversations || []),
    objects:       (_readJSON(OBJECTS_FILE)        ?.worldObjects  || []),
  };
}

function _jsonDiskCounts() {
  return {
    agents:        (_readJSON(AGENTS_FILE)        ?.agents        ?.length || 0),
    events:        (_readJSON(EVENTS_FILE)         ?.eventLog      ?.length || 0),
    conversations: (_readJSON(CONVERSATIONS_FILE)  ?.conversations ?.length || 0),
    objects:       (_readJSON(OBJECTS_FILE)        ?.worldObjects  ?.length || 0),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PostgreSQL implementations
// ═══════════════════════════════════════════════════════════════════════════════

async function _pgSave(sim) {
  const pool   = _getDb().getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Upsert all agents
    for (const a of sim.agents) {
      const s = _serializeAgent(a);
      await client.query(
        `INSERT INTO agents (id, name, data) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET name = $2, data = $3`,
        [s.id, s.name, JSON.stringify(s)]
      );
    }

    // Upsert used names
    for (const n of sim.agents.map(a => a.name.toLowerCase())) {
      await client.query(
        'INSERT INTO used_names (name) VALUES ($1) ON CONFLICT DO NOTHING',
        [n]
      );
    }

    // Upsert world state (single row keyed 'main')
    await client.query(
      `INSERT INTO world (key, data) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET data = $2`,
      ['main', JSON.stringify(_buildWorldPayload(sim))]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function _pgSaveObjects(sim) {
  const pool = _getDb().getPool();
  for (const o of (sim.worldObjects || [])) {
    const obj = {
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
      visualSVG:   o.visualSVG   || null,
      purpose:     o.purpose     || null,
      category:    o.category    || null,
      position:    o.position    || null,
    };
    await pool.query(
      `INSERT INTO objects (id, data) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET data = $2`,
      [o.id, JSON.stringify(obj)]
    );
  }
  await pool.query(
    `INSERT INTO object_meta (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
    ['next_id', sim._nextWOId || 1]
  );
}

async function _pgSaveConversations(sim) {
  const pool = _getDb().getPool();
  for (const [key, msgs] of (sim.conversations || new Map())) {
    const res        = await pool.query(
      'SELECT MAX(ts) AS max_ts FROM conversations WHERE pair_key = $1',
      [key]
    );
    const lastDiskTs = res.rows[0]?.max_ts ? Number(res.rows[0].max_ts) : 0;
    const newMsgs    = msgs.filter(m => m.ts > lastDiskTs);
    for (const msg of newMsgs) {
      await pool.query(
        'INSERT INTO conversations (pair_key, ts, msg_data) VALUES ($1, $2, $3)',
        [key, msg.ts, JSON.stringify(msg)]
      );
    }
  }
}

async function _pgSaveEvents(sim) {
  const pool       = _getDb().getPool();
  const res        = await pool.query('SELECT MAX(ts) AS max_ts FROM events');
  const lastDiskTs = res.rows[0]?.max_ts ? Number(res.rows[0].max_ts) : 0;
  const newEvents  = (sim.eventLog || []).filter(e => e.ts > lastDiskTs);
  for (const e of newEvents) {
    await pool.query(
      `INSERT INTO events (ts, agent_id, partner_agent_id, type, msg, data)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [e.ts, e.agentId || null, e.partnerAgentId || null, e.type || null, e.msg || null, JSON.stringify(e)]
    );
  }
}

async function _pgLoad() {
  const pool = _getDb().getPool();

  const [agentsRes, namesRes, worldRes] = await Promise.all([
    pool.query('SELECT data FROM agents'),
    pool.query('SELECT name FROM used_names'),
    pool.query("SELECT data FROM world WHERE key = 'main'"),
  ]);

  const agents    = agentsRes.rows.map(r => r.data);
  const usedNames = namesRes.rows.map(r => r.name);
  const agentData = agents.length > 0 ? { agents, usedNames } : null;
  const worldData = worldRes.rows[0]?.data || null;

  if (!agentData || !worldData) return null;

  const [objsRes, objMetaRes, evRes] = await Promise.all([
    pool.query('SELECT data FROM objects'),
    pool.query("SELECT value FROM object_meta WHERE key = 'next_id'"),
    pool.query('SELECT data FROM events ORDER BY ts ASC'),
  ]);

  const objectsData = {
    worldObjects:      objsRes.rows.map(r => r.data),
    worldObjectNextId: objMetaRes.rows[0]?.value || 1,
  };

  const eventsData = { eventLog: evRes.rows.map(r => r.data) };

  const convRes = await pool.query(
    'SELECT pair_key, msg_data FROM conversations ORDER BY ts ASC'
  );
  const convMap = new Map();
  for (const row of convRes.rows) {
    if (!convMap.has(row.pair_key)) convMap.set(row.pair_key, []);
    convMap.get(row.pair_key).push(row.msg_data);
  }
  const convArr = [];
  for (const [key, msgs] of convMap) convArr.push({ key, msgs });
  const conversationsData = { conversations: convArr };

  return { agentData, worldData, objectsData, conversationsData, eventsData };
}

async function _pgLoadEventPage({ before = null, limit = 50, agentName = null } = {}) {
  const pool       = _getDb().getPool();
  const conditions = [];
  const params     = [];

  if (agentName) {
    const nameLower = agentName.toLowerCase().trim();
    const agentRes  = await pool.query(
      'SELECT id FROM agents WHERE LOWER(name) = $1',
      [nameLower]
    );
    const agentId = agentRes.rows[0]?.id || null;
    params.push(`%${nameLower}%`);
    if (agentId) {
      params.push(agentId);
      conditions.push(
        `(agent_id = $${params.length} OR partner_agent_id = $${params.length} OR msg ILIKE $${params.length - 1})`
      );
    } else {
      conditions.push(`msg ILIKE $${params.length}`);
    }
  }

  if (before !== null) {
    params.push(Number(before));
    conditions.push(`ts < $${params.length}`);
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  // Fetch limit+1 rows (newest-first) to determine hasMore
  params.push(limit + 1);
  const res = await pool.query(
    `SELECT data FROM events ${where} ORDER BY ts DESC LIMIT $${params.length}`,
    params
  );

  const hasMore = res.rows.length > limit;
  const events  = res.rows.slice(0, limit).map(r => r.data);
  return { events, hasMore };
}

async function _pgLoadHistoryByAgent(agentName) {
  const pool      = _getDb().getPool();
  const nameLower = (agentName || '').toLowerCase().trim();
  if (!nameLower) return { agent: null, events: [], conversations: [] };

  const agentRes = await pool.query(
    'SELECT data FROM agents WHERE LOWER(name) = $1',
    [nameLower]
  );
  const agent   = agentRes.rows[0]?.data || null;
  const agentId = agent?.id || null;

  let evRes;
  if (agentId) {
    evRes = await pool.query(
      `SELECT data FROM events
       WHERE agent_id = $1 OR partner_agent_id = $1 OR msg ILIKE $2
       ORDER BY ts ASC`,
      [agentId, `%${nameLower}%`]
    );
  } else {
    evRes = await pool.query(
      'SELECT data FROM events WHERE msg ILIKE $1 ORDER BY ts ASC',
      [`%${nameLower}%`]
    );
  }

  const convRes = await pool.query(
    `SELECT pair_key, array_agg(msg_data ORDER BY ts ASC) AS msgs
     FROM conversations
     WHERE pair_key LIKE $1 OR pair_key LIKE $2
     GROUP BY pair_key`,
    [`${nameLower}|%`, `%|${nameLower}`]
  );

  return {
    agent,
    events:        evRes.rows.map(r => r.data),
    conversations: convRes.rows.map(r => ({ key: r.pair_key, msgs: r.msgs })),
  };
}

async function _pgLoadFullHistory() {
  const pool = _getDb().getPool();
  const [agentsRes, evRes, objsRes] = await Promise.all([
    pool.query('SELECT data FROM agents'),
    pool.query('SELECT data FROM events ORDER BY ts ASC'),
    pool.query('SELECT data FROM objects'),
  ]);

  const convRes = await pool.query(
    'SELECT pair_key, msg_data FROM conversations ORDER BY ts ASC'
  );
  const convMap = new Map();
  for (const row of convRes.rows) {
    if (!convMap.has(row.pair_key)) convMap.set(row.pair_key, []);
    convMap.get(row.pair_key).push(row.msg_data);
  }
  const conversations = [];
  for (const [key, msgs] of convMap) conversations.push({ key, msgs });

  return {
    agents:        agentsRes.rows.map(r => r.data),
    events:        evRes.rows.map(r => r.data),
    conversations,
    objects:       objsRes.rows.map(r => r.data),
  };
}

async function _pgDiskCounts() {
  const pool = _getDb().getPool();
  const [a, e, c, o] = await Promise.all([
    pool.query('SELECT COUNT(*) AS cnt FROM agents'),
    pool.query('SELECT COUNT(*) AS cnt FROM events'),
    pool.query('SELECT COUNT(DISTINCT pair_key) AS cnt FROM conversations'),
    pool.query('SELECT COUNT(*) AS cnt FROM objects'),
  ]);
  return {
    agents:        parseInt(a.rows[0].cnt, 10),
    events:        parseInt(e.rows[0].cnt, 10),
    conversations: parseInt(c.rows[0].cnt, 10),
    objects:       parseInt(o.rows[0].cnt, 10),
  };
}

async function _pgIntegrityCheck() {
  const counts = await _pgDiskCounts();
  // PG tables always exist and are never corrupt (DB handles integrity)
  return [
    { name: 'agents',        exists: true, count: counts.agents,        size: 0, corrupt: false },
    { name: 'events',        exists: true, count: counts.events,        size: 0, corrupt: false },
    { name: 'conversations', exists: true, count: counts.conversations, size: 0, corrupt: false },
    { name: 'objects',       exists: true, count: counts.objects,       size: 0, corrupt: false },
  ];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Public API — async, dispatches to PG or JSON based on DATABASE_URL
// ═══════════════════════════════════════════════════════════════════════════════

function _isPg() {
  const db = _getDb();
  return db.usePg && db.getPool();
}

async function save(sim) {
  try {
    if (_isPg()) await _pgSave(sim);
    else _jsonSave(sim);
  } catch (err) { console.error('[Persistence] save failed:', err.message); }
}

async function saveObjects(sim) {
  try {
    if (_isPg()) await _pgSaveObjects(sim);
    else _jsonSaveObjects(sim);
  } catch (err) { console.error('[Persistence] saveObjects failed:', err.message); }
}

async function saveConversations(sim) {
  try {
    if (_isPg()) await _pgSaveConversations(sim);
    else _jsonSaveConversations(sim);
  } catch (err) { console.error('[Persistence] saveConversations failed:', err.message); }
}

async function saveEvents(sim) {
  try {
    if (_isPg()) await _pgSaveEvents(sim);
    else _jsonSaveEvents(sim);
  } catch (err) { console.error('[Persistence] saveEvents failed:', err.message); }
}

async function load() {
  try {
    if (_isPg()) return await _pgLoad();
    return _jsonLoad();
  } catch (err) {
    console.error('[Persistence] Load failed:', err.message);
    return null;
  }
}

async function loadEventPage(opts) {
  try {
    if (_isPg()) return await _pgLoadEventPage(opts);
    return _jsonLoadEventPage(opts);
  } catch (err) {
    console.error('[Persistence] loadEventPage failed:', err.message);
    return { events: [], hasMore: false };
  }
}

async function loadHistoryByAgent(agentName) {
  try {
    if (_isPg()) return await _pgLoadHistoryByAgent(agentName);
    return _jsonLoadHistoryByAgent(agentName);
  } catch (err) {
    console.error('[Persistence] loadHistoryByAgent failed:', err.message);
    return { agent: null, events: [], conversations: [] };
  }
}

async function loadFullHistory() {
  try {
    if (_isPg()) return await _pgLoadFullHistory();
    return _jsonLoadFullHistory();
  } catch (err) {
    console.error('[Persistence] loadFullHistory failed:', err.message);
    return { agents: [], events: [], conversations: [], objects: [] };
  }
}

async function diskCounts() {
  try {
    if (_isPg()) return await _pgDiskCounts();
    return _jsonDiskCounts();
  } catch (err) {
    console.error('[Persistence] diskCounts failed:', err.message);
    return { agents: 0, events: 0, conversations: 0, objects: 0 };
  }
}

async function integrityCheck() {
  try {
    if (_isPg()) return await _pgIntegrityCheck();
    return _jsonIntegrityCheck();
  } catch (err) {
    console.error('[Persistence] integrityCheck failed:', err.message);
    return [];
  }
}

module.exports = {
  hashKey, verifyKey, findAgentByKey,
  save, saveObjects, saveConversations, saveEvents,
  load, loadFullHistory, diskCounts,
  integrityCheck, loadHistoryByAgent, loadEventPage,
};

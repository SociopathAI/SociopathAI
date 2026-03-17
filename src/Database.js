'use strict';
// Database.js — PostgreSQL connection + table setup
// Used only when DATABASE_URL env var is set.
// When DATABASE_URL is absent, usePg=false and this module is a no-op.

const { Pool } = require('pg');

// Read at call-time, not at require-time, so Railway env injection is always caught
function _dbUrl() { return process.env.DATABASE_URL || ''; }

let _pool = null;

// For hosted PG (Heroku, Render, etc.) we need SSL. For local, skip it.
function _sslOpts() {
  const url = _dbUrl();
  if (/localhost|127\.0\.0\.1/.test(url)) return false;
  return { rejectUnauthorized: false };
}

async function initDb() {
  const dbUrl = _dbUrl();
  if (!dbUrl) {
    console.log('Database: Using local JSON files');
    return false;
  }

  _pool = new Pool({
    connectionString: dbUrl,
    ssl: _sslOpts(),
  });

  // Verify connectivity
  await _pool.query('SELECT 1');

  // Create tables in a single transaction
  await _pool.query(`
    CREATE TABLE IF NOT EXISTS agents (
      id   TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      data JSONB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS used_names (
      name TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS world (
      key  TEXT PRIMARY KEY,
      data JSONB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id               SERIAL PRIMARY KEY,
      ts               BIGINT NOT NULL,
      agent_id         TEXT,
      partner_agent_id TEXT,
      type             TEXT,
      msg              TEXT,
      data             JSONB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id       SERIAL PRIMARY KEY,
      pair_key TEXT   NOT NULL,
      ts       BIGINT NOT NULL,
      msg_data JSONB  NOT NULL
    );

    CREATE TABLE IF NOT EXISTS objects (
      id   TEXT PRIMARY KEY,
      data JSONB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS object_meta (
      key   TEXT    PRIMARY KEY,
      value INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat (
      id        TEXT   PRIMARY KEY,
      ts        BIGINT NOT NULL,
      name      TEXT   NOT NULL,
      ai_system TEXT,
      text      TEXT   NOT NULL
    );
  `);

  // Schema migrations — IF NOT EXISTS guards ensure existing data is never lost
  await _pool.query(`
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS education_notes TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS memory_summary   TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS message_queue    JSONB   DEFAULT '[]';
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS jitter_ms        INTEGER DEFAULT 0;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS api_status       VARCHAR(20) DEFAULT 'ok';
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS backoff_until    BIGINT  DEFAULT 0;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS model_name       VARCHAR(100);
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_seen_at     BIGINT  DEFAULT 0;
  `);

  // Indexes (safe to run repeatedly)
  await _pool.query(`
    CREATE INDEX IF NOT EXISTS events_ts_idx       ON events (ts);
    CREATE INDEX IF NOT EXISTS events_agent_id_idx ON events (agent_id);
    CREATE INDEX IF NOT EXISTS conv_pair_key_idx   ON conversations (pair_key, ts);
    CREATE INDEX IF NOT EXISTS chat_ts_idx         ON chat (ts);
  `);

  console.log('Database: PostgreSQL connected');
  return true;
}

function getPool() { return _pool; }

// usePg is a live getter — always reflects the current env value, never frozen at require-time
module.exports = {
  get usePg() { return !!_dbUrl(); },
  initDb,
  getPool,
};

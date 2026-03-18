'use strict';
// reset.js — wipe all simulation data, keep table/file structure intact
// Run with:  node scripts/reset.js
// Works for both PostgreSQL (DATABASE_URL set) and local JSON file mode.

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// ─── JSON file reset ───────────────────────────────────────────────────────────

const JSON_RESETS = {
  'agents.json':        JSON.stringify({ agents: [], usedNames: [] }),
  'world.json':         JSON.stringify({}),
  'events.json':        JSON.stringify({ eventLog: [] }),
  'conversations.json': JSON.stringify({ conversations: [] }),
  'objects.json':       JSON.stringify({ worldObjects: [], worldObjectNextId: 1 }),
};

function resetJsonFiles() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log('[reset] Created data/ directory');
  }
  for (const [file, empty] of Object.entries(JSON_RESETS)) {
    const fp = path.join(DATA_DIR, file);
    fs.writeFileSync(fp, empty, 'utf8');
    console.log(`[reset] Cleared ${file}`);
  }
}

// ─── PostgreSQL reset ──────────────────────────────────────────────────────────

async function resetPostgres(dbUrl) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: dbUrl,
    ssl: /localhost|127\.0\.0\.1/.test(dbUrl) ? false : { rejectUnauthorized: false },
  });

  try {
    await pool.query('SELECT 1'); // verify connection
    console.log('[reset] PostgreSQL connected');

    // TRUNCATE each table individually — if one fails the others still run
    const tables = [
      'agents',
      'events',
      'conversations',
      'objects',
      'object_meta',
      'chat',
      'world',
      'used_names',
    ];
    for (const table of tables) {
      try {
        await pool.query(`TRUNCATE TABLE ${table} CASCADE;`);
        console.log(`[reset] Truncated: ${table}`);
      } catch (err) {
        console.warn(`[reset] Could not truncate ${table}: ${err.message}`);
      }
    }
  } finally {
    await pool.end();
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== SociopathAI Data Reset ===\n');

  // Always reset JSON files (belt-and-suspenders for JSON mode)
  resetJsonFiles();

  // Reset PostgreSQL if DATABASE_URL is present
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    console.log('\n[reset] DATABASE_URL detected — resetting PostgreSQL...');
    try {
      await resetPostgres(dbUrl);
    } catch (err) {
      console.error('[reset] PostgreSQL reset FAILED:', err.message);
      process.exit(1);
    }
  } else {
    console.log('\n[reset] No DATABASE_URL — skipping PostgreSQL (JSON mode only)');
  }

  console.log('\n=== Reset complete. World starts fresh. ===\n');
  console.log('=== ALL DONE ===');
}

main().catch(err => {
  console.error('[reset] Fatal:', err.message);
  process.exit(1);
});

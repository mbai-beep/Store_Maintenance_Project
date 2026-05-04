#!/usr/bin/env node
// scripts/inspect-source.js - peek at the source DB so you know what we're migrating.
// Same env vars as the migrator (uses SOURCE_TURSO_URL + SOURCE_TURSO_TOKEN only).
const { createClient } = require('@libsql/client');

function need(n) { const v = process.env[n]; if (!v) { console.error('Missing env: ' + n); process.exit(1); } return v; }

(async () => {
  const db = createClient({ url: need('SOURCE_TURSO_URL'), authToken: need('SOURCE_TURSO_TOKEN') });
  const tables = await db.execute(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`);
  console.log('Tables:'); tables.rows.forEach(r => console.log('  - ' + r.name));
  console.log('');
  const cols = await db.execute(`PRAGMA table_info(employees)`);
  console.log('employees columns:');
  cols.rows.forEach(r => console.log('  ' + r.name + ' (' + r.type + (r.notnull ? ', NOT NULL' : '') + (r.pk ? ', PK' : '') + ')'));
  console.log('');
  const cnt = await db.execute(`SELECT COUNT(*) AS n FROM employees`);
  console.log('Row count: ' + cnt.rows[0].n);
  const sample = await db.execute(`SELECT * FROM employees LIMIT 3`);
  console.log('Sample rows:');
  sample.rows.forEach((r, i) => {
    const safe = { ...r };
    if (safe.password_hash) safe.password_hash = String(safe.password_hash).slice(0, 18) + '...';
    console.log('  [' + i + '] ' + JSON.stringify(safe));
  });
})().catch(err => { console.error(err); process.exit(1); });

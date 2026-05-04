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

  for (const t of ['employees', 'employee_auth']) {
    const exists = tables.rows.some(r => r.name === t);
    if (!exists) { console.log('[' + t + '] table not present'); continue; }
    const cols = await db.execute(`PRAGMA table_info(${t})`);
    console.log('[' + t + '] columns:');
    cols.rows.forEach(r => console.log('    ' + r.name + ' (' + r.type + (r.notnull ? ', NOT NULL' : '') + (r.pk ? ', PK' : '') + ')'));
    const cnt = await db.execute(`SELECT COUNT(*) AS n FROM ${t}`);
    console.log('  row count: ' + cnt.rows[0].n);
    const sample = await db.execute(`SELECT * FROM ${t} LIMIT 3`);
    console.log('  sample rows:');
    sample.rows.forEach((r, i) => {
      const safe = { ...r };
      for (const k of Object.keys(safe)) {
        if (/pass|hash|secret|token/i.test(k) && safe[k]) safe[k] = String(safe[k]).slice(0, 22) + '...';
      }
      console.log('    [' + i + '] ' + JSON.stringify(safe));
    });
    console.log('');
  }
})().catch(err => { console.error(err); process.exit(1); });

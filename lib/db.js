// lib/db.js - Turso (libSQL) client + schema migrations for auth + maintenance app.
const { createClient } = require('@libsql/client');

let _client = null;
let _migrated = false;

function getDB() {
  if (_client) return _client;
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error('TURSO_DATABASE_URL env var is missing');
  _client = createClient({ url, authToken });
  return _client;
}

// Idempotent migrations. Called from every API entrypoint on cold start.
async function ensureSchema() {
  if (_migrated) return;
  const db = getDB();

  await db.execute(`
    CREATE TABLE IF NOT EXISTS employees (
      emp_code             INTEGER PRIMARY KEY,
      emp_name             TEXT NOT NULL,
      emp_designation      TEXT DEFAULT '',
      emp_mobile           TEXT DEFAULT '',
      store_name           TEXT DEFAULT '',
      store_code           TEXT DEFAULT '',
      role                 TEXT NOT NULL DEFAULT 'employee',
      password_hash        TEXT NOT NULL,
      is_first_login       INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 1,
      password_changed_at  TEXT,
      tc_accepted          INTEGER NOT NULL DEFAULT 0,
      store_status         TEXT NOT NULL DEFAULT 'Active',
      created_at           TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS employee_password_history (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      emp_code      INTEGER NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_pwd_history_emp ON employee_password_history(emp_code, created_at DESC)`);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token       TEXT PRIMARY KEY,
      emp_code    INTEGER NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at  TEXT NOT NULL,
      remember    INTEGER NOT NULL DEFAULT 0
    )
  `);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_sessions_emp ON auth_sessions(emp_code)`);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS otp_codes (
      emp_code     INTEGER PRIMARY KEY,
      mobile       TEXT NOT NULL,
      otp          TEXT NOT NULL,
      reset_token  TEXT,
      verified     INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at   TEXT NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS stores (
      code         TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Bootstrap: seed an admin user so somebody can sign in. Default password = MB@1
  const existing = await db.execute({
    sql: `SELECT emp_code FROM employees WHERE role='admin' LIMIT 1`,
    args: [],
  });
  if (existing.rows.length === 0) {
    const { hashPassword } = require('./auth');
    const hash = await hashPassword('MB@1');
    await db.execute({
      sql: `INSERT INTO employees (emp_code, emp_name, emp_designation, role, password_hash, store_name, store_code, is_first_login, must_change_password, store_status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 'Active')`,
      args: [1, 'Admin', 'Administrator', 'admin', hash, 'HQ', 'HQ'],
    });
    console.log('[lib/db] seeded default admin: empCode=1 password=MB@1 (will be forced to change)');
  }

  _migrated = true;
}

module.exports = { getDB, ensureSchema };

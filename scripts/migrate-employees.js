#!/usr/bin/env node
// scripts/migrate-employees.js
// Copy `employees` (+ `employee_auth` join) from old Turso DB into new DB.
// Idempotent: re-running just refreshes existing rows.
const { createClient } = require('@libsql/client');

function need(name) {
  const v = process.env[name];
  if (!v) { console.error('Missing env var: ' + name); process.exit(1); }
  return v;
}

const SOURCE_URL   = need('SOURCE_TURSO_URL');
const SOURCE_TOKEN = need('SOURCE_TURSO_TOKEN');
const TARGET_URL   = need('TARGET_TURSO_URL');
const TARGET_TOKEN = need('TARGET_TURSO_TOKEN');
const FORCE_PWD_CHANGE = process.env.FORCE_PWD_CHANGE === '1';

(async () => {
  const src = createClient({ url: SOURCE_URL, authToken: SOURCE_TOKEN });
  const tgt = createClient({ url: TARGET_URL, authToken: TARGET_TOKEN });

  console.log('[1/5] Ensuring target schema...');
  await tgt.execute(`
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

  console.log('[2/5] Inspecting source schema...');
  const srcEmpCols = (await src.execute(`PRAGMA table_info(employees)`)).rows.map(r => r.name);
  const hasAuthTable = (await src.execute(`SELECT name FROM sqlite_master WHERE type='table' AND name='employee_auth'`)).rows.length > 0;
  let authCols = [];
  if (hasAuthTable) {
    authCols = (await src.execute(`PRAGMA table_info(employee_auth)`)).rows.map(r => r.name);
  }
  console.log('     employees columns: ' + srcEmpCols.join(', '));
  if (hasAuthTable) console.log('     employee_auth columns: ' + authCols.join(', '));

  // Find which column in employee_auth holds the password hash
  const authPwdCol = authCols.find(c => /^(password_hash|pwd_hash|password)$/i.test(c));
  const authEmpCodeCol = authCols.find(c => /^(emp_code|empcode|employee_id|emp_id|user_id)$/i.test(c)) || 'emp_code';
  if (hasAuthTable && !authPwdCol) {
    console.error('!! employee_auth table exists but no obvious password column found. Columns: ' + authCols.join(', '));
    process.exit(2);
  }
  console.log('     using ' + (hasAuthTable ? `employee_auth.${authPwdCol} (joined on ${authEmpCodeCol})` : 'employees.password_hash'));

  console.log('[3/5] Reading source rows...');
  let rows;
  if (hasAuthTable) {
    const r = await src.execute(`
      SELECT e.*, a."${authPwdCol}" AS _pwd_hash
      FROM employees e
      LEFT JOIN employee_auth a ON a."${authEmpCodeCol}" = e.emp_code
    `);
    rows = r.rows;
  } else {
    const r = await src.execute(`SELECT * FROM employees`);
    rows = r.rows;
  }
  console.log('     ' + rows.length + ' rows fetched');

  function pick(row, ...candidates) {
    for (const c of candidates) {
      if (Object.prototype.hasOwnProperty.call(row, c) && row[c] != null && row[c] !== '') return row[c];
    }
    return null;
  }
  function normalizeRole(raw) {
    const r = String(raw || 'employee').toLowerCase().trim();
    const map = { 'owner':'owner', 'manager':'manager', 'buyer':'buyer', 'admin':'admin',
                  'employee':'employee', 'staff':'employee', 'sales executive':'employee',
                  'stock executive':'employee', 'cashier':'employee' };
    return map[r] || (['owner','manager','buyer','admin','employee'].includes(r) ? r : 'employee');
  }

  console.log('[4/5] Upserting into target...');
  let okCount = 0, skipped = 0, noPwd = 0;
  for (const row of rows) {
    const empCode = pick(row, 'emp_code', 'empCode');
    const empName = pick(row, 'emp_name', 'empName', 'name');
    let passwordHash = pick(row, '_pwd_hash', 'password_hash', 'pwd_hash');
    if (!empCode || !empName) {
      console.warn('  !! skipping row missing emp_code/emp_name: ' + JSON.stringify(row).slice(0, 120));
      skipped++;
      continue;
    }
    if (!passwordHash) {
      // No password row in employee_auth - generate the default MB@<empCode> hash so they can sign in
      const bcrypt = require('bcryptjs');
      passwordHash = bcrypt.hashSync('MB@' + empCode, 10);
      noPwd++;
    }
    const empDesignation = pick(row, 'emp_designation', 'designation') || '';
    const empMobile      = pick(row, 'emp_mobile', 'mobile') || '';
    const storeName      = pick(row, 'store_name', 'storeName') || '';
    const storeCode      = pick(row, 'store_code', 'storeCode') || '';
    const role           = normalizeRole(pick(row, 'role'));
    const storeStatus    = pick(row, 'store_status', 'status') || 'Active';
    const isFirstLogin   = FORCE_PWD_CHANGE ? 1 : 0;
    const mustChange     = FORCE_PWD_CHANGE ? 1 : 0;

    await tgt.execute({
      sql: `INSERT INTO employees (
              emp_code, emp_name, emp_designation, emp_mobile, store_name, store_code, role,
              password_hash, is_first_login, must_change_password, tc_accepted, store_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
            ON CONFLICT(emp_code) DO UPDATE SET
              emp_name             = excluded.emp_name,
              emp_designation      = excluded.emp_designation,
              emp_mobile           = excluded.emp_mobile,
              store_name           = excluded.store_name,
              store_code           = excluded.store_code,
              role                 = excluded.role,
              password_hash        = excluded.password_hash,
              is_first_login       = excluded.is_first_login,
              must_change_password = excluded.must_change_password,
              store_status         = excluded.store_status`,
      args: [
        empCode, empName, empDesignation, empMobile, storeName, storeCode, role,
        passwordHash, isFirstLogin, mustChange, storeStatus,
      ],
    });
    okCount++;
  }

  console.log('[5/5] Done.');
  console.log('---');
  console.log('  migrated:        ' + okCount);
  console.log('  skipped:         ' + skipped);
  console.log('  default-pwd-set: ' + noPwd + '  (employees with no row in employee_auth got password = MB@<empCode>)');
  console.log('  total source:    ' + rows.length);
})().catch(err => { console.error('FAILED:', err); process.exit(1); });

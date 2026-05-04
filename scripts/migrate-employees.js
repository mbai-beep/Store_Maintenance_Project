#!/usr/bin/env node
// scripts/migrate-employees.js
// One-shot copy of `employees` from the old Turso DB (mbz-customer-req) into the
// new Turso DB (mbz-store-req). Idempotent: re-running just refreshes existing rows.
//
// Usage (from project root):
//   SOURCE_TURSO_URL="libsql://mbz-customer-req-mbz-admin.aws-ap-south-1.turso.io" \
//   SOURCE_TURSO_TOKEN="<token-for-old-db>" \
//   TARGET_TURSO_URL="libsql://mbz-store-req-mbz-admin.aws-ap-south-1.turso.io" \
//   TARGET_TURSO_TOKEN="<token-for-new-db>" \
//   node scripts/migrate-employees.js
//
// Windows PowerShell:
//   $env:SOURCE_TURSO_URL="libsql://mbz-customer-req-mbz-admin.aws-ap-south-1.turso.io"
//   $env:SOURCE_TURSO_TOKEN="<token>"
//   $env:TARGET_TURSO_URL="libsql://mbz-store-req-mbz-admin.aws-ap-south-1.turso.io"
//   $env:TARGET_TURSO_TOKEN="<token>"
//   node scripts/migrate-employees.js
//
// Get tokens with:
//   turso db tokens create mbz-customer-req
//   turso db tokens create mbz-store-req

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
const FORCE_PWD_CHANGE = process.env.FORCE_PWD_CHANGE === '1'; // mark every migrated user as "must change pwd"

(async () => {
  const src = createClient({ url: SOURCE_URL, authToken: SOURCE_TOKEN });
  const tgt = createClient({ url: TARGET_URL, authToken: TARGET_TOKEN });

  // 1. Make sure the target table exists with the new-schema columns.
  console.log('[1/4] Ensuring target schema...');
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

  // 2. Inspect source schema so we map only columns that actually exist.
  console.log('[2/4] Inspecting source schema...');
  const srcCols = await src.execute(`PRAGMA table_info(employees)`);
  const srcColNames = srcCols.rows.map(r => r.name);
  console.log('     source columns: ' + srcColNames.join(', '));
  if (srcColNames.length === 0) { console.error('!! source DB has no employees table'); process.exit(2); }

  function pick(row, ...candidates) {
    for (const c of candidates) {
      if (Object.prototype.hasOwnProperty.call(row, c) && row[c] != null) return row[c];
    }
    return null;
  }

  // 3. Read every row from source.
  console.log('[3/4] Reading source rows...');
  const allCols = '"' + srcColNames.join('", "') + '"';
  const r = await src.execute(`SELECT ${allCols} FROM employees`);
  console.log('     ' + r.rows.length + ' rows to migrate');

  // 4. Upsert into target.
  console.log('[4/4] Upserting into target...');
  let okCount = 0, skipped = 0;
  for (const row of r.rows) {
    const empCode = pick(row, 'emp_code', 'empCode', 'EmpCode', 'id');
    const empName = pick(row, 'emp_name', 'empName', 'EmpName', 'name', 'full_name');
    const passwordHash = pick(row, 'password_hash', 'passwordHash', 'pwd_hash', 'password');
    if (!empCode || !empName || !passwordHash) {
      console.warn('  !! skipping row missing emp_code/emp_name/password_hash: ' + JSON.stringify(row).slice(0, 200));
      skipped++;
      continue;
    }
    const empDesignation = pick(row, 'emp_designation', 'designation', 'job_title') || '';
    const empMobile      = pick(row, 'emp_mobile', 'mobile', 'phone') || '';
    const storeName      = pick(row, 'store_name', 'storeName', 'store') || '';
    const storeCode      = pick(row, 'store_code', 'storeCode') || '';
    let role             = pick(row, 'role') || 'employee';
    role = String(role).toLowerCase();
    if (!['employee', 'manager', 'buyer', 'owner', 'admin'].includes(role)) role = 'employee';
    const tcAccepted     = pick(row, 'tc_accepted', 'tcAccepted') ? 1 : 0;
    const storeStatus    = pick(row, 'store_status', 'status', 'storeStatus') || 'Active';
    const isFirstLogin   = FORCE_PWD_CHANGE ? 1 : (pick(row, 'is_first_login', 'isFirstLogin') ? 1 : 0);
    const mustChange     = FORCE_PWD_CHANGE ? 1 : (pick(row, 'must_change_password', 'mustChangePassword') ? 1 : 0);
    const pwdChangedAt   = pick(row, 'password_changed_at', 'passwordChangedAt') || null;

    await tgt.execute({
      sql: `INSERT INTO employees (
              emp_code, emp_name, emp_designation, emp_mobile, store_name, store_code, role,
              password_hash, is_first_login, must_change_password, password_changed_at, tc_accepted, store_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
              password_changed_at  = excluded.password_changed_at,
              tc_accepted          = excluded.tc_accepted,
              store_status         = excluded.store_status`,
      args: [
        empCode, empName, empDesignation, empMobile, storeName, storeCode, role,
        passwordHash, isFirstLogin, mustChange, pwdChangedAt, tcAccepted, storeStatus,
      ],
    });
    okCount++;
  }

  console.log('---');
  console.log('  migrated:  ' + okCount);
  console.log('  skipped:   ' + skipped);
  console.log('  total src: ' + r.rows.length);
  console.log('Done.');
})().catch(err => { console.error('FAILED:', err); process.exit(1); });

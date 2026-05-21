#!/usr/bin/env node
// scripts/reset-all-passwords.js
// One-time bulk reset: every active employee's password becomes MB@<empCode>,
// with is_first_login=1 so the app forces them to set their own password on
// their next login.
//
// Usage (PowerShell):
//   $env:TURSO_DATABASE_URL = "libsql://..."
//   $env:TURSO_AUTH_TOKEN   = "eyJ..."
//   node scripts/reset-all-passwords.js              # dry-run, prints what it WOULD do
//   node scripts/reset-all-passwords.js --apply      # actually writes
//
// Optional flags:
//   --skip-admin           Leave role='admin' rows untouched (recommended)
//   --skip-codes=1,2,3     Comma-separated emp_codes to leave alone (your own login etc.)

const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');

function need(name) {
  const v = process.env[name];
  if (!v) { console.error('Missing env var: ' + name); process.exit(1); }
  return v;
}

const TURSO_URL   = need('TURSO_DATABASE_URL');
const TURSO_TOKEN = need('TURSO_AUTH_TOKEN');

const argv = process.argv.slice(2);
const APPLY      = argv.includes('--apply');
const SKIP_ADMIN = argv.includes('--skip-admin');
const skipCodesArg = argv.find(a => a.startsWith('--skip-codes='));
const SKIP_CODES = new Set(
  (skipCodesArg ? skipCodesArg.split('=')[1] : '')
    .split(',').map(s => s.trim()).filter(Boolean).map(Number),
);

(async () => {
  const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
  const mode = APPLY ? 'APPLY' : 'DRY-RUN';
  console.log(`\n=== Password bulk reset — ${mode} ===`);
  if (SKIP_ADMIN)   console.log('  (admin rows will be skipped)');
  if (SKIP_CODES.size) console.log('  (skip codes: ' + [...SKIP_CODES].join(', ') + ')');

  const r = await db.execute(`SELECT emp_code, emp_name, role, store_status FROM employees ORDER BY emp_code`);
  console.log('  total employees in DB: ' + r.rows.length);

  let touched = 0, skipped = 0, inactive = 0;

  for (const row of r.rows) {
    const empCode = Number(row.emp_code);
    const role = String(row.role || '').toLowerCase();
    const isActive = String(row.store_status || 'Active') === 'Active';

    if (!isActive)                 { inactive++; continue; }
    if (SKIP_ADMIN && role === 'admin') { skipped++; continue; }
    if (SKIP_CODES.has(empCode))   { skipped++; continue; }

    const newHash = bcrypt.hashSync('MB@' + empCode, 10);
    if (APPLY) {
      await db.execute({
        sql: `UPDATE employees
              SET password_hash = ?,
                  is_first_login = 1,
                  must_change_password = 1,
                  password_changed_at = NULL
              WHERE emp_code = ?`,
        args: [newHash, empCode],
      });
      // Wipe their password history so the 3-password-reuse check doesn't
      // immediately reject "MB@<empCode>" as a banned recent password.
      await db.execute({
        sql: `DELETE FROM employee_password_history WHERE emp_code = ?`,
        args: [empCode],
      });
    }
    touched++;
    if (touched <= 10) {
      console.log(`  ${APPLY ? 'reset' : 'would reset'}  ${empCode}  ${row.emp_name}  (role=${role})`);
    } else if (touched === 11) {
      console.log('  ...');
    }
  }

  console.log('---');
  console.log('  would-reset / reset : ' + touched);
  console.log('  skipped             : ' + skipped + (SKIP_ADMIN || SKIP_CODES.size ? '  (by --skip flags)' : ''));
  console.log('  inactive (skipped)  : ' + inactive);
  if (!APPLY) console.log('\n  NOTHING WRITTEN. Re-run with --apply to actually update the DB.');
  else        console.log('\n  DONE. Every reset employee now logs in with MB@<empCode> and will be forced to set their own password.');
})().catch(e => { console.error('FAILED:', e); process.exit(1); });

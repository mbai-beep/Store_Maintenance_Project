# Deployment Steps — Store Maintenance Web App v2

All code is now in place on disk. Two things still need YOU to do them, because the sandbox doesn't have permission to push to GitHub or set Vercel env vars:

1. Clear a stuck git lock + commit + push
2. Add new environment variables to Vercel and run the Turso migrations

---

## 1. Clear the stuck git lock and commit

There's a stale `.git/index.lock` left over from an earlier session. From a Windows PowerShell or Command Prompt:

```
cd D:\AI_ML_Projects\Store_Maintenance_Web_App
del .git\index.lock
git status
```

You should see all the new files (lib/db.js, lib/auth.js, api/auth.js, api/admin.js, api/otp.js, api/stores.js, api/file.js, api/update-status.js) and the modified ones (api/entries.js, api/upload.js, lib/google.js, public/index.html, package.json, vercel.json).

Then commit and push:

```
git add .
git commit -m "feat: add Turso-backed auth, admin panel, OTP forgot-password; rewire entries/upload for store maintenance"
git push origin main
```

Vercel auto-deploys from `main`.

## 2. Environment variables (Vercel dashboard)

Go to https://vercel.com → your `mbz-audit-app` project → **Settings → Environment Variables**.

You already have these (from `.env.local`):

- `GOOGLE_SERVICE_ACCOUNT_JSON` — full JSON of the service-account credentials (one line, escaped)
- `SHEET_ID` — Google Sheet ID
- `SHEET_TAB_NAME` — tab name (e.g. `Requests`)
- `DRIVE_FOLDER_ID` — root Drive folder for uploads
- `NODE_ENV=production`

**Add these new ones:**

| Variable                | Value                                                                  |
| ----------------------- | ---------------------------------------------------------------------- |
| `TURSO_DATABASE_URL`    | `libsql://mbz-store-req-mbz-admin.aws-ap-south-1.turso.io`             |
| `TURSO_AUTH_TOKEN`      | (from `turso db tokens create mbz-store-req`)                          |
| `FAST2SMS_API_KEY`      | OPTIONAL — leave blank for demo mode (OTP returned in API response)    |

After saving, click **Deployments → Redeploy** so the latest build picks up the new vars.

## 3. Turso schema migrations

The schema is **auto-created** on first API call by `lib/db.js` → `ensureSchema()`. You don't need to run any DDL manually. On the very first hit to `/api/auth?action=verify` (which the frontend fires on page load), the following tables come into existence:

- `employees`
- `employee_password_history`
- `auth_sessions`
- `otp_codes`
- `stores`

A default admin user is also seeded:

- **Employee ID:** `1`
- **Password:** `MB@1`
- **Role:** `admin`
- Will be forced to change password on first login.

**After login, immediately use the Admin tab to:**
1. Add real employees (default password `MB@<empCode>` is auto-set; first-login change forced).
2. Optionally seed the `stores` table directly via Turso CLI:
   ```sql
   INSERT INTO stores (code, name) VALUES ('S01', 'MG Road Store'), ('S02', 'Brigade Road Store');
   ```
   If you skip this, the store filter in the admin UI auto-derives stores from employees.

## 4. Smoke test (after Vercel deploys)

Open https://mbz-audit-app.vercel.app and verify:

- [ ] Login page loads
- [ ] Sign in with `1` / `MB@1` → "Set Your Password" modal appears (first-login forces change)
- [ ] Set password to e.g. `Admin@2026` → lands on the app, store info auto-populated
- [ ] Try setting password back to `MB@1` → blocked with "cannot reuse last 3 passwords"
- [ ] Submit a maintenance request with 2 photos → appears in the Sheet's `Requests` tab with `requestType=Store Maintenance`
- [ ] Submit with only 1 photo → blocked client-side AND server-side
- [ ] Admin tab → Add Employee `1234`, name "Test Emp" → toast shows default `MB@1234`
- [ ] Logout, login as `1234`/`MB@1234` → forced password change
- [ ] Forgot Password flow → OTP shown in demo mode (no SMS configured)

## 5. New / changed files in this delivery

**New:**
- `lib/db.js` — Turso client + idempotent schema migrations + admin bootstrap
- `lib/auth.js` — bcrypt hashing, session tokens, password expiry/reuse helpers
- `api/auth.js` — login / verify / change-password / reset-password / accept-tc
- `api/admin.js` — get-employee / add-employee / reset-password / toggle-status
- `api/otp.js` — Fast2SMS-based OTP send/verify (demo mode if no API key)
- `api/stores.js` — store list endpoint
- `api/file.js` — Drive file proxy for audio playback
- `api/update-status.js` — fulfillment status updater
- `BACKEND_NOTES.md` — design notes (in /outputs)
- `DEPLOY_STEPS.md` — this file

**Modified:**
- `public/index.html` — full new Store Maintenance frontend
- `lib/google.js` — Sheet schema upgraded (17 columns, includes fulfillmentStatus, audioUrl, requestType)
- `api/upload.js` — accepts both legacy (`photo`) and new (`fileData`) field names
- `api/entries.js` — returns plain array, supports filters (storeCode, dateFrom, dateTo, requestType, role, limit), enforces 2-photo minimum server-side
- `api/_db.js` — converted to a backwards-compatible shim re-exporting from `lib/db`
- `package.json` — added `@libsql/client@^0.14.0` and `bcryptjs@^2.4.3`
- `vercel.json` — added rewrite for `/` → `/index.html` and per-function maxDuration

## 6. Sheet schema

If you have existing rows in your Sheet's `Requests` tab from the Customer Requirement app, the new column order is:

```
A id
B createdAt
C storeName
D storeCode
E requirement
F description
G employee
H employeeId
I status
J fulfillmentStatus
K photoCount
L photoUrls
M audioUrl
N voiceDuration
O requestType
P customerName
Q mobileNumber
```

`ensureHeaderRow()` will rewrite row 1 on first call. Existing data in columns A–J already matches; columns K–Q will be empty for legacy rows, which is fine (the GET handler defaults `fulfillmentStatus` to `Pending` and `requestType` to `Store Maintenance`). If your old data was actually a "Customer Requirement" app, manually backfill column O with `Customer Requirement` for those rows so they don't show up in the maintenance app's submissions list.

## 7. Rollback

If anything goes wrong, the previous build is one-click revertable from the Vercel dashboard → Deployments → click the last working deploy → "Promote to production". The Turso tables are idempotent — re-running `ensureSchema()` is safe.

---

## 8. Migrating employees from `mbz-customer-req` → `mbz-store-req`

This brings every employee row (including hashed passwords) from your existing Customer Requirement DB into the new Store Maintenance DB so people can sign in with their existing credentials.

### Prereqs

- Turso CLI installed (`turso --help` works on Windows)
- You're logged in (`turso auth whoami`)

### Step 1 — Get fresh tokens for both databases

```
turso db tokens create mbz-customer-req
turso db tokens create mbz-store-req
```

Copy each long `eyJ...` token.

### Step 2 — Inspect the source first (sanity check)

```
cd D:\AI_ML_Projects\Store_Maintenance_Web_App

# PowerShell:
$env:SOURCE_TURSO_URL="libsql://mbz-customer-req-mbz-admin.aws-ap-south-1.turso.io"
$env:SOURCE_TURSO_TOKEN="<paste token>"
npm run inspect-source
```

Expected output: list of tables, column definitions for `employees`, row count, 3 sample rows (with the password_hash truncated for safety).

### Step 3 — Run the migration

```
# PowerShell:
$env:TARGET_TURSO_URL="libsql://mbz-store-req-mbz-admin.aws-ap-south-1.turso.io"
$env:TARGET_TURSO_TOKEN="<paste new-db token>"

# Optional: force every migrated user to change password on first login of the new app
# $env:FORCE_PWD_CHANGE="1"

npm run migrate-employees
```

You'll see something like:
```
[1/4] Ensuring target schema...
[2/4] Inspecting source schema...
     source columns: emp_code, emp_name, ...
[3/4] Reading source rows...
     147 rows to migrate
[4/4] Upserting into target...
---
  migrated:  147
  skipped:   0
  total src: 147
Done.
```

### Step 4 — Test login

Visit https://store-maintenance-project.vercel.app/ and sign in with `2266` / `MB@2266` (or whatever password the user already had on the customer-requirement app — same hash carries over).

### Notes

- The migration is **idempotent** — re-running just refreshes existing rows (UPSERT on emp_code).
- Password hashes are copied as-is; bcrypt-format hashes work transparently across both apps.
- If a row in the source DB is missing `emp_code`, `emp_name`, or `password_hash`, it's skipped with a warning.
- Set `FORCE_PWD_CHANGE=1` if you want everyone to be forced through a change-password flow the first time they log in to the new app (useful if the customer-req app didn't have a password expiry).
- The script auto-creates the new table schema if it doesn't exist yet, so you don't need to wait for the first API call to bootstrap it.

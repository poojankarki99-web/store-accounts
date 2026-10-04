# Store Accounts

Multi-store accounts website: money IN/OUT, customer payouts, holding balance, bank payments,
manager expenses, and role-based access (admin / manager / employee). Mobile-first UI.
Built for free hosting; fully portable — standard Node.js + Express + plain PostgreSQL.

## Quick start (Docker — easiest)

```bash
docker compose up --build -d
# open http://localhost:3000
```

The app auto-applies `schema.sql` on boot and seeds the admin account on first run.

**Admin login:** username `pkboi123` · password `Demo@12345`
(Change it after first login: sign in → Password.)

## Local run without Docker

Requirements: Node.js 18+ and PostgreSQL 13+.

```bash
cp .env.example .env        # edit DATABASE_URL / SESSION_SECRET
npm install
npm start                   # listens on :3000 (PORT env)
```

`npm start` applies `schema.sql` automatically and creates the admin account
if the `users` table is empty. To seed explicitly: `npm run seed`.

## How it works

- **Roles** — `admin` (everything), `manager` (reports for assigned stores, expenses,
  edits; no edit-log access), `employee` (Report Entry / Payout Entry only, no reports).
- **Stores** — admin creates storefronts and assigns them (managers can hold many stores).
- **Entries** — employees submit Report Entries (hours worked, IN/OUT, auto Net,
  Customer Out rows) and Payout Entries (Name / Tag-Email / Amount). Every entry gets an
  automatic server timestamp shown in both **Central (America/Chicago)** and **Nepal**
  time; business-day logic uses Central Time.
- **Money rules** — "With Drawn Amount" (payout total) is never subtracted from Net;
  a payout that would exceed the store's total net is rejected with "Not Enough Balance".
- **Holding Balance** — the current month's net profit (Central month). Hand Balance =
  withdrawn − manager-entered partner %.
- **Audit** — every admin/manager edit is logged (old → new, who, when); visible to
  admin only. Admin Alerts page shows each edit in yellow, red when a manager edits
  IN/OUT numbers.

## Migrating your data (backup / move hosts)

Everything lives in plain PostgreSQL — no extensions, no proprietary services.

```bash
# Backup
pg_dump "$DATABASE_URL" --no-owner > storeaccounts-backup.sql

# Restore on the new host (empty database)
psql "$NEW_DATABASE_URL" -f storeaccounts-backup.sql
```

Then point the app's `DATABASE_URL` at the new database and start it. That's the whole
migration — the 2-week trial move is just: dump, restore, redeploy.

## Free-hosting notes

- Any host that runs Node + Postgres works: Render / Railway / Fly.io / a VPS, etc.
- Free tiers commonly **sleep when idle** — the first visit after a quiet spell can
  take ~30–60s to wake up; afterwards it's normal speed.
- Set `COOKIE_SECURE=true` when serving over HTTPS.
- Keep regular `pg_dump` backups (see above), especially on free database tiers.

## Project layout

```
schema.sql            # idempotent Postgres schema (also auto-applied on boot)
src/server.js         # Express app, sessions, static frontend
src/db.js             # pg pool + migrate()
src/auth.js           # password rules, role/store-access middleware
src/audit.js          # field-level edit audit helper
src/time.js           # Central/Nepal timezone helpers
src/storeMath.js      # net / withdrawn totals
src/seed.js           # creates the admin account (idempotent)
src/routes/          # auth, admin, entries, manager, bank, reports
public/              # mobile-first SPA (index.html, styles.css, app.js)
Dockerfile
docker-compose.yml    # app + postgres
```

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — (required) | Postgres connection string |
| `SESSION_SECRET` | dev-only | Signs session cookies — set a long random value |
| `PORT` | 3000 | HTTP port |
| `COOKIE_SECURE` | false | `true` behind HTTPS |
| `CORS_ORIGINS` | empty | Comma-separated allowed origins (usually unnecessary) |
| `NODE_ENV` | — | `production` hides error stacks |

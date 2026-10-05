-- Store Accounts schema — plain PostgreSQL, no extensions.
-- Safe to run multiple times (CREATE TABLE IF NOT EXISTS).
-- Migratable with: pg_dump "$DATABASE_URL" > backup.sql  /  psql "$DATABASE_URL" -f backup.sql

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'employee')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_deleted    BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS stores (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  location   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Store assignments (managers can have MANY stores; employees have their store(s))
CREATE TABLE IF NOT EXISTS user_stores (
  user_id  INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store_id INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, store_id)
);

-- Employee "Report Entry": daily money IN/OUT + hours worked
CREATE TABLE IF NOT EXISTS report_entries (
  id                  SERIAL PRIMARY KEY,
  store_id            INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  user_id             INT NOT NULL REFERENCES users(id),
  hours_worked_minutes INT NOT NULL DEFAULT 0,
  in_amount           NUMERIC(12,2) NOT NULL DEFAULT 0,
  out_amount          NUMERIC(12,2) NOT NULL DEFAULT 0,
  net_amount          NUMERIC(12,2) NOT NULL DEFAULT 0, -- IN - OUT, computed by app
  entry_date          DATE NOT NULL,                    -- Central-time business date
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_report_entries_store_date ON report_entries(store_id, entry_date);

-- "Customer Out" rows inside a Report Entry
CREATE TABLE IF NOT EXISTS customer_payouts (
  id              SERIAL PRIMARY KEY,
  report_entry_id INT NOT NULL REFERENCES report_entries(id) ON DELETE CASCADE,
  customer_name   TEXT NOT NULL,
  game_name       TEXT NOT NULL,
  amount          NUMERIC(12,2) NOT NULL DEFAULT 0
);

-- Employee "Payout Entry": a submission of payout rows (Name / Tag-Email / Amount)
CREATE TABLE IF NOT EXISTS payout_entries (
  id         SERIAL PRIMARY KEY,
  store_id   INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  user_id    INT NOT NULL REFERENCES users(id),
  entry_date DATE NOT NULL, -- Central-time business date
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payout_entries_store_date ON payout_entries(store_id, entry_date);

CREATE TABLE IF NOT EXISTS payout_rows (
  id              SERIAL PRIMARY KEY,
  payout_entry_id INT NOT NULL REFERENCES payout_entries(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  tag_email       TEXT NOT NULL,
  amount          NUMERIC(12,2) NOT NULL DEFAULT 0
);

-- Manager-entered partner cut percent, one per payout entry
CREATE TABLE IF NOT EXISTS partner_cuts (
  id              SERIAL PRIMARY KEY,
  payout_entry_id INT NOT NULL UNIQUE REFERENCES payout_entries(id) ON DELETE CASCADE,
  percent         NUMERIC(5,2) NOT NULL,
  entered_by      INT NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bank_payments (
  id             SERIAL PRIMARY KEY,
  store_id       INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  user_id        INT NOT NULL REFERENCES users(id),
  bank_name      TEXT NOT NULL,
  account_number TEXT NOT NULL,
  amount         NUMERIC(12,2) NOT NULL DEFAULT 0,
  payment_date   DATE NOT NULL,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bank_payments_store_date ON bank_payments(store_id, payment_date);

CREATE TABLE IF NOT EXISTS manager_expenses (
  id           SERIAL PRIMARY KEY,
  store_id     INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  user_id      INT NOT NULL REFERENCES users(id),
  amount       NUMERIC(12,2) NOT NULL DEFAULT 0,
  category     TEXT NOT NULL,
  description  TEXT,
  expense_date DATE NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_manager_expenses_store_date ON manager_expenses(store_id, expense_date);

-- Edit audit trail (admin-only visibility). Alerts are derived from this table.
CREATE TABLE IF NOT EXISTS edit_audit (
  id         SERIAL PRIMARY KEY,
  entry_type TEXT NOT NULL, -- report_entry | payout_row | manager_expense | bank_payment | partner_cut
  entry_id   INT NOT NULL,
  field_name TEXT NOT NULL,
  old_value  TEXT,
  new_value  TEXT,
  edited_by  INT NOT NULL REFERENCES users(id),
  edited_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_edit_audit_edited_at ON edit_audit(edited_at DESC);
-- Resolved flag for admin alerts (added later; safe on existing DBs)
ALTER TABLE edit_audit ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE edit_audit ADD COLUMN IF NOT EXISTS resolved_by INT REFERENCES users(id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE users ADD COLUMN IF NOT EXISTS can_edit_entries BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_by INTEGER;

ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by INTEGER;

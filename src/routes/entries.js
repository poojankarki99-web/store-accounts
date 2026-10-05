'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole, requireStoreAccess } = require('../auth');
const { applyAuditedUpdate } = require('../audit');
const { num, storeTotals } = require('../storeMath');
const { centralDateKey, formatBoth, isValidDateKey } = require('../time');

const router = express.Router();
router.use(requireAuth);

function cleanStr(v, max = 200) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

// ---------------- Employee: Report Entry ----------------
// POST /api/entries/report
router.post('/report', requireStoreAccess, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { hours, minutes, inAmount, customerPayouts } = req.body || {};
    const h = Math.max(0, Math.min(24, parseInt(hours, 10) || 0));
    const m = Math.max(0, Math.min(59, parseInt(minutes, 10) || 0));
    const inA = num(inAmount);
    if (inA < 0) return res.status(400).json({ error: 'Amounts cannot be negative' });

    const rows = Array.isArray(customerPayouts) ? customerPayouts : [];
    for (const r of rows) {
      if (!cleanStr(r.customerName) || !cleanStr(r.gameName)) {
        return res.status(400).json({ error: 'Each Customer Out row needs a name and a game name' });
      }
      if (num(r.amount) < 0) return res.status(400).json({ error: 'Amounts cannot be negative' });
    }
    // Net = IN minus Customer Payouts (the generic "Out" field is retired)
    const custTotal = Math.round(rows.reduce((s, r) => s + num(r.amount), 0) * 100) / 100;
    const net = Math.round((inA - custTotal) * 100) / 100;

    await client.query('BEGIN');
    const { rows: er } = await client.query(
      `INSERT INTO report_entries (store_id, user_id, hours_worked_minutes, in_amount, out_amount, net_amount, entry_date)
       VALUES ($1,$2,$3,$4,0,$5,$6) RETURNING *`,
      [req.storeId, req.user.id, h * 60 + m, inA, net, centralDateKey()]
    );
    const entry = er[0];
    for (const r of rows) {
      await client.query(
        'INSERT INTO customer_payouts (report_entry_id, customer_name, game_name, amount) VALUES ($1,$2,$3,$4)',
        [entry.id, cleanStr(r.customerName), cleanStr(r.gameName), num(r.amount)]
      );
    }
    await client.query('COMMIT');
    res.status(201).json({ ok: true, entry: { ...entry, timestamps: formatBoth(entry.created_at) } });
  } catch (e) {
    await client.query('ROLLBACK');
    next(e);
  } finally {
    client.release();
  }
});

// ---------------- Employee: Payout Entry ----------------
// POST /api/entries/payout
// Rule: total payout (Withdrawn Amount) can NEVER exceed the store's total net amount.
router.post('/payout', requireStoreAccess, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: 'Add at least one payout row' });
    for (const r of rows) {
      if (!cleanStr(r.name) || !cleanStr(r.tagEmail)) {
        return res.status(400).json({ error: 'Each payout row needs a name and a tag/email' });
      }
      if (num(r.amount) <= 0) return res.status(400).json({ error: 'Payout amounts must be greater than zero' });
    }
    const total = Math.round(rows.reduce((s, r) => s + num(r.amount), 0) * 100) / 100;
    const { net } = await storeTotals(req.storeId);
    if (total > net) {
      return res.status(400).json({ error: 'Not Enough Balance' });
    }
    await client.query('BEGIN');
    const { rows: er } = await client.query(
      `INSERT INTO payout_entries (store_id, user_id, entry_date) VALUES ($1,$2,$3) RETURNING *`,
      [req.storeId, req.user.id, centralDateKey()]
    );
    const entry = er[0];
    for (const r of rows) {
      await client.query(
        'INSERT INTO payout_rows (payout_entry_id, name, tag_email, amount) VALUES ($1,$2,$3,$4)',
        [entry.id, cleanStr(r.name), cleanStr(r.tagEmail), num(r.amount)]
      );
    }
    await client.query('COMMIT');
    res.status(201).json({ ok: true, entry: { ...entry, total, timestamps: formatBoth(entry.created_at) } });
  } catch (e) {
    await client.query('ROLLBACK');
    next(e);
  } finally {
    client.release();
  }
});

// ---------------- Edits (admin + manager; every change is audited) ----------------
const canEdit = requireRole('admin', 'manager');

router.put('/report/:id', canEdit, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM report_entries WHERE id = $1', [req.params.id]);
    const cur = rows[0];
    if (!cur) return res.status(404).json({ error: 'Entry not found' });
    if (req.user.role !== 'admin') {
      const { accessibleStoreIds } = require('../auth');
      const ids = await accessibleStoreIds(req.user);
      if (!ids.includes(cur.store_id)) return res.status(403).json({ error: 'No access to this store' });
    }
    const changes = {};
    if (req.body.inAmount !== undefined) changes.in_amount = num(req.body.inAmount);
    if (req.body.hoursWorkedMinutes !== undefined) changes.hours_worked_minutes = Math.max(0, parseInt(req.body.hoursWorkedMinutes, 10) || 0);
    // Transfer entry to another employee
    if (req.body.userId !== undefined) {
      const newUserId = Number(req.body.userId);
      const { rows: uRows } = await pool.query('SELECT id, role FROM users WHERE id = $1', [newUserId]);
      const target = uRows[0];
      if (!target || target.role !== 'employee') return res.status(400).json({ error: 'Pick a valid employee' });
      if (req.user.role === 'manager') {
        const { rows: shared } = await pool.query(
          `SELECT 1 FROM user_stores a JOIN user_stores b ON a.store_id = b.store_id
           WHERE a.user_id = $1 AND b.user_id = $2 LIMIT 1`, [req.user.id, newUserId]);
        if (!shared[0]) return res.status(403).json({ error: 'Employee is not in your stores' });
      }
      changes.user_id = newUserId;
    }
    // Move entry to a different date
    if (req.body.entryDate !== undefined && req.body.entryDate !== '') {
      if (!isValidDateKey(req.body.entryDate)) return res.status(400).json({ error: 'Invalid date' });
      changes.entry_date = req.body.entryDate;
    }
    const newIn = changes.in_amount !== undefined ? changes.in_amount : num(cur.in_amount);
    // Net = IN minus this entry's Customer Payouts (generic "Out" is retired)
    const { rows: cpSum } = await pool.query(
      'SELECT COALESCE(SUM(amount),0) AS t FROM customer_payouts WHERE report_entry_id = $1', [cur.id]);
    changes.net_amount = Math.round((newIn - num(cpSum[0].t)) * 100) / 100;
    const r = await applyAuditedUpdate({
      table: 'report_entries', id: cur.id, entryType: 'report_entry',
      changes, current: cur, editedBy: req.user.id,
    });
    res.json({ ok: true, ...r });
  } catch (e) { next(e); }
});

router.put('/customer-payout/:id', canEdit, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT cp.*, re.store_id FROM customer_payouts cp JOIN report_entries re ON re.id = cp.report_entry_id WHERE cp.id = $1`,
      [req.params.id]
    );
    const cur = rows[0];
    if (!cur) return res.status(404).json({ error: 'Row not found' });
    if (req.user.role !== 'admin') {
      const { accessibleStoreIds } = require('../auth');
      const ids = await accessibleStoreIds(req.user);
      if (!ids.includes(cur.store_id)) return res.status(403).json({ error: 'No access to this store' });
    }
    const changes = {};
    if (req.body.customerName !== undefined) changes.customer_name = cleanStr(req.body.customerName);
    if (req.body.gameName !== undefined) changes.game_name = cleanStr(req.body.gameName);
    if (req.body.amount !== undefined) changes.amount = num(req.body.amount);
    const r = await applyAuditedUpdate({
      table: 'customer_payouts', id: cur.id, entryType: 'customer_payout',
      changes, current: cur, editedBy: req.user.id,
    });
    res.json({ ok: true, ...r });
  } catch (e) { next(e); }
});

router.put('/payout-row/:id', canEdit, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT pr.*, pe.store_id FROM payout_rows pr JOIN payout_entries pe ON pe.id = pr.payout_entry_id WHERE pr.id = $1`,
      [req.params.id]
    );
    const cur = rows[0];
    if (!cur) return res.status(404).json({ error: 'Row not found' });
    if (req.user.role !== 'admin') {
      const { accessibleStoreIds } = require('../auth');
      const ids = await accessibleStoreIds(req.user);
      if (!ids.includes(cur.store_id)) return res.status(403).json({ error: 'No access to this store' });
    }
    const changes = {};
    if (req.body.name !== undefined) changes.name = cleanStr(req.body.name);
    if (req.body.tagEmail !== undefined) changes.tag_email = cleanStr(req.body.tagEmail);
    if (req.body.amount !== undefined) {
      const newAmount = num(req.body.amount);
      // Re-validate the Not Enough Balance rule after the change
      const { net, withdrawnTotal } = await storeTotals(cur.store_id);
      const newWithdrawn = Math.round((withdrawnTotal - num(cur.amount) + newAmount) * 100) / 100;
      if (newWithdrawn > net) return res.status(400).json({ error: 'Not Enough Balance' });
      changes.amount = newAmount;
    }
    const r = await applyAuditedUpdate({
      table: 'payout_rows', id: cur.id, entryType: 'payout_row',
      changes, current: cur, editedBy: req.user.id,
    });
    res.json({ ok: true, ...r });
  } catch (e) { next(e); }
});

module.exports = router;

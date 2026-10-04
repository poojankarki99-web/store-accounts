'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole, accessibleStoreIds } = require('../auth');
const { num } = require('../storeMath');
const { formatBoth, isValidDateKey, centralDateKey, centralMonthRange, lastCompletedCentralMonth, isValidMonthKey, monthRangeFromKey } = require('../time');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'manager'));

// Resolve store list: single id or "all" (admin only; managers pick assigned stores)
async function resolveStores(req) {
  const raw = req.query.store;
  const ids = await accessibleStoreIds(req.user);
  if (!raw || raw === 'all') {
    if (req.user.role === 'manager') {
      throw Object.assign(new Error('Combined view is admin-only — pick one of your stores'), { status: 403 });
    }
    return { ids, combined: true };
  }
  const id = Number(raw);
  if (!ids.includes(id)) throw Object.assign(new Error('No access to this store'), { status: 403 });
  return { ids: [id], combined: false };
}

function stamp(r) {
  return { ...r, timestamps: formatBoth(r.created_at) };
}

// GET /api/reports/dashboard?store=<id|all>&from&to
// Net Profit defaults to the ENTIRE month's net profit (Central month) when no range given.
router.get('/dashboard', async (req, res, next) => {
  try {
    const { ids, combined } = await resolveStores(req);
    let { from, to } = req.query;
    if (!from || !to || !isValidDateKey(from) || !isValidDateKey(to)) {
      const m = centralMonthRange();
      from = m.start; to = m.end;
    }
    const today = centralDateKey();

    // IN entries (top section)
    const inQ = await pool.query(
      `SELECT re.*, u.username, s.name AS store_name FROM report_entries re
       JOIN users u ON u.id = re.user_id JOIN stores s ON s.id = re.store_id
       WHERE re.store_id = ANY($1) AND re.entry_date >= $2 AND re.entry_date <= $3
       ORDER BY re.entry_date DESC, re.id DESC`, [ids, from, to]);

    // Customer Out rows (count as expenses in net)
    const cpQ = await pool.query(
      `SELECT cp.*, re.entry_date, re.store_id, s.name AS store_name FROM customer_payouts cp
       JOIN report_entries re ON re.id = cp.report_entry_id
       JOIN stores s ON s.id = re.store_id
       WHERE re.store_id = ANY($1) AND re.entry_date >= $2 AND re.entry_date <= $3
       ORDER BY re.entry_date DESC`, [ids, from, to]);

    // Payout entries + rows (bottom Payout section; Withdrawn Amount, never subtracted)
    const peQ = await pool.query(
      `SELECT pe.*, u.username, s.name AS store_name FROM payout_entries pe
       JOIN users u ON u.id = pe.user_id JOIN stores s ON s.id = pe.store_id
       WHERE pe.store_id = ANY($1) AND pe.entry_date >= $2 AND pe.entry_date <= $3
       ORDER BY pe.entry_date DESC, pe.id DESC`, [ids, from, to]);
    const peIds = peQ.rows.map((r) => r.id);
    let prRows = [];
    if (peIds.length) {
      const { rows } = await pool.query(
        'SELECT * FROM payout_rows WHERE payout_entry_id = ANY($1) ORDER BY id', [peIds]);
      prRows = rows;
    }

    // Manager expenses (count as expenses in net)
    const exQ = await pool.query(
      `SELECT e.*, u.username, s.name AS store_name FROM manager_expenses e
       JOIN users u ON u.id = e.user_id JOIN stores s ON s.id = e.store_id
       WHERE e.store_id = ANY($1) AND e.expense_date >= $2 AND e.expense_date <= $3
       ORDER BY e.expense_date DESC`, [ids, from, to]);

    const inTotal = num(inQ.rows.reduce((s, r) => s + Number(r.in_amount), 0));
    const outTotal = num(inQ.rows.reduce((s, r) => s + Number(r.out_amount), 0));
    const custPayoutTotal = num(cpQ.rows.reduce((s, r) => s + Number(r.amount), 0));
    const expenseTotal = num(exQ.rows.reduce((s, r) => s + Number(r.amount), 0));
    const expenseGrand = Math.round((outTotal + custPayoutTotal + expenseTotal) * 100) / 100;
    const netProfit = Math.round((inTotal - expenseGrand) * 100) / 100;
    const withdrawnTotal = num(prRows.reduce((s, r) => s + Number(r.amount), 0));

    // "Withdrawn Balance for the day": only when entries exist that day
    const dayQ = await pool.query(
      `SELECT COUNT(*) AS c FROM payout_entries WHERE store_id = ANY($1) AND entry_date = $2`, [ids, today]);
    const dayHasEntries = Number(dayQ.rows[0].c) > 0;
    let withdrawnToday = null;
    if (dayHasEntries) {
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(pr.amount),0) AS t FROM payout_rows pr
         JOIN payout_entries pe ON pe.id = pr.payout_entry_id
         WHERE pe.store_id = ANY($1) AND pe.entry_date = $2`, [ids, today]);
      withdrawnToday = { date: today, total: num(rows[0].t) };
    }

    res.json({
      combined,
      range: { from, to },
      incomeExpense: {
        inSection: { total: inTotal, entries: inQ.rows.map(stamp) },
        payoutSection: {
          total: withdrawnTotal,
          entries: peQ.rows.map((pe) => ({
            ...stamp(pe),
            rows: prRows.filter((r) => r.payout_entry_id === pe.id),
          })),
        },
      },
      outBreakdown: { outTotal, customerPayoutTotal: custPayoutTotal, expenseTotal, expenseGrand },
      netProfit,
      withdrawnToday, // null when no entries that day
      expenses: exQ.rows.map(stamp),
      customerPayouts: cpQ.rows,
    });
  } catch (e) { next(e); }
});

// GET /api/reports/holding?store=<id>&mode=month|range&month=YYYY-MM&start=YYYY-MM-DD&end=YYYY-MM-DD
// Single store only. Main figure = net profit for the chosen period (Central).
// mode=month: whole Central month (defaults to current month). mode=range: exact start/end dates.
router.get('/holding', async (req, res, next) => {
  try {
    const raw = req.query.store;
    const ids = await accessibleStoreIds(req.user);
    const storeId = Number(raw);
    if (!ids.includes(storeId)) return res.status(403).json({ error: 'Select a single store for Holding Balance' });

    const mode = req.query.mode === 'range' ? 'range' : 'month';
    const currentMonth = centralMonthRange().monthLabel;
    let start, end, label, monthKey = null;
    if (mode === 'range') {
      const s = req.query.start, e = req.query.end;
      if (!isValidDateKey(s) || !isValidDateKey(e) || s > e) {
        return res.status(400).json({ error: 'Pick a valid start and end date' });
      }
      start = s; end = e; label = `${s} → ${e}`;
    } else {
      monthKey = isValidMonthKey(req.query.month) ? req.query.month : currentMonth;
      const r = monthRangeFromKey(monthKey);
      start = r.start; end = r.end; label = r.monthLabel;
    }

    // Period net profit (Holding Balance main figure)
    const rep = await pool.query(
      `SELECT COALESCE(SUM(in_amount),0) AS it, COALESCE(SUM(out_amount),0) AS ot
       FROM report_entries WHERE store_id = $1 AND entry_date >= $2 AND entry_date <= $3`,
      [storeId, start, end]);
    const cp = await pool.query(
      `SELECT COALESCE(SUM(cp.amount),0) AS t FROM customer_payouts cp
       JOIN report_entries re ON re.id = cp.report_entry_id
       WHERE re.store_id = $1 AND re.entry_date >= $2 AND re.entry_date <= $3`,
      [storeId, start, end]);
    const ex = await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS t FROM manager_expenses
       WHERE store_id = $1 AND expense_date >= $2 AND expense_date <= $3`,
      [storeId, start, end]);
    const periodIn = num(rep.rows[0].it);
    const periodOut = num(rep.rows[0].ot) + num(cp.rows[0].t) + num(ex.rows[0].t);
    const holdingBalance = Math.round((periodIn - periodOut) * 100) / 100;

    // Total withdrawn for the period (top, below net profit — no names)
    const wd = await pool.query(
      `SELECT COALESCE(SUM(pr.amount),0) AS t FROM payout_rows pr
       JOIN payout_entries pe ON pe.id = pr.payout_entry_id
       WHERE pe.store_id = $1 AND pe.entry_date >= $2 AND pe.entry_date <= $3`, [storeId, start, end]);
    const totalWithdrawn = num(wd.rows[0].t);

    // Payout entries for the period with rows + partner cut + hand balance
    const { rows: pes } = await pool.query(
      `SELECT pe.*, u.username FROM payout_entries pe JOIN users u ON u.id = pe.user_id
       WHERE pe.store_id = $1 AND pe.entry_date >= $2 AND pe.entry_date <= $3 ORDER BY pe.entry_date DESC, pe.id`, [storeId, start, end]);
    const details = [];
    for (const pe of pes) {
      const { rows: rowsQ } = await pool.query('SELECT * FROM payout_rows WHERE payout_entry_id = $1 ORDER BY id', [pe.id]);
      const { rows: cutQ } = await pool.query('SELECT percent FROM partner_cuts WHERE payout_entry_id = $1', [pe.id]);
      const entryTotal = num(rowsQ.reduce((s, r) => s + Number(r.amount), 0));
      const percent = cutQ[0] ? Number(cutQ[0].percent) : null;
      const handBalance = percent === null ? null : Math.round((entryTotal * (1 - percent / 100)) * 100) / 100;
      details.push({
        ...stamp(pe),
        rows: rowsQ,
        entryTotal,
        partnerPercent: percent,
        handBalance,
      });
    }

    // Report entries for the period
    const periodEntries = await pool.query(
      `SELECT re.*, u.username FROM report_entries re JOIN users u ON u.id = re.user_id
       WHERE re.store_id = $1 AND re.entry_date >= $2 AND re.entry_date <= $3 ORDER BY re.entry_date DESC`,
      [storeId, start, end]);

    res.json({
      storeId,
      mode,
      period: { start, end, label, month: monthKey },
      currentMonth,
      holdingBalance,          // period net profit (Central period)
      totalWithdrawn,          // withdrawn for the period
      details,                 // payout entries w/ rows + hand balance
      entries: periodEntries.rows.map(stamp),
      periodIn, periodOut,
    });
  } catch (e) { next(e); }
});

// GET /api/reports/cih?store=<id|all>&month=YYYY-MM
// CIH Report: "Money Made" = Withdrawn Amount (total of payout rows for the month)
//             minus Total Expenses (manager expenses for the month).
// Default month: last completed Central month. Numbers-focused; per store selector.
router.get('/cih', async (req, res, next) => {
  try {
    const { ids, combined } = await resolveStores(req);
    let month = req.query.month;
    if (!isValidMonthKey(month)) month = lastCompletedCentralMonth().monthLabel;
    const { start, end } = monthRangeFromKey(month);

    // Withdrawn Amount for the month (payout rows; never subtracted from Net elsewhere)
    const wd = await pool.query(
      `SELECT COALESCE(SUM(pr.amount),0) AS t FROM payout_rows pr
       JOIN payout_entries pe ON pe.id = pr.payout_entry_id
       WHERE pe.store_id = ANY($1) AND pe.entry_date >= $2 AND pe.entry_date <= $3`,
      [ids, start, end]);
    const withdrawn = num(wd.rows[0].t);

    // Individual expenses for the month
    const { rows: expenses } = await pool.query(
      `SELECT e.*, u.username, s.name AS store_name FROM manager_expenses e
       JOIN users u ON u.id = e.user_id JOIN stores s ON s.id = e.store_id
       WHERE e.store_id = ANY($1) AND e.expense_date >= $2 AND e.expense_date <= $3
       ORDER BY e.expense_date DESC, e.id DESC`, [ids, start, end]);
    const expenseTotal = num(expenses.reduce((s, r) => s + Number(r.amount), 0));
    const moneyMade = Math.round((withdrawn - expenseTotal) * 100) / 100;

    // Per-store breakdown for the admin combined view
    let perStore = null;
    if (combined) {
      const { rows: stores } = await pool.query('SELECT id, name FROM stores WHERE id = ANY($1) ORDER BY name', [ids]);
      const wBy = await pool.query(
        `SELECT pe.store_id, COALESCE(SUM(pr.amount),0) AS t FROM payout_rows pr
         JOIN payout_entries pe ON pe.id = pr.payout_entry_id
         WHERE pe.store_id = ANY($1) AND pe.entry_date >= $2 AND pe.entry_date <= $3
         GROUP BY pe.store_id`, [ids, start, end]);
      const eBy = await pool.query(
        `SELECT store_id, COALESCE(SUM(amount),0) AS t FROM manager_expenses
         WHERE store_id = ANY($1) AND expense_date >= $2 AND expense_date <= $3
         GROUP BY store_id`, [ids, start, end]);
      const wMap = Object.fromEntries(wBy.rows.map((r) => [r.store_id, Number(r.t)]));
      const eMap = Object.fromEntries(eBy.rows.map((r) => [r.store_id, Number(r.t)]));
      perStore = stores.map((s) => {
        const w = num(wMap[s.id] || 0);
        const e = num(eMap[s.id] || 0);
        return { storeId: s.id, storeName: s.name, withdrawn: w, expenseTotal: e, moneyMade: Math.round((w - e) * 100) / 100 };
      });
    }

    res.json({
      combined, month, range: { start, end },
      withdrawn, expenseTotal, moneyMade,
      expenses: expenses.map(stamp),
      perStore,
    });
  } catch (e) { next(e); }
});

// GET /api/reports/entries?store=<id|all>&from&to&type=report|payout
router.get('/entries', async (req, res, next) => {
  try {
    const { ids } = await resolveStores(req);
    const m = centralMonthRange();
    const from = req.query.from && isValidDateKey(req.query.from) ? req.query.from : m.start;
    const to = req.query.to && isValidDateKey(req.query.to) ? req.query.to : m.end;
    const type = req.query.type || 'report';

    if (type === 'payout') {
      const { rows } = await pool.query(
        `SELECT pe.*, u.username, s.name AS store_name FROM payout_entries pe
         JOIN users u ON u.id = pe.user_id JOIN stores s ON s.id = pe.store_id
         WHERE pe.store_id = ANY($1) AND pe.entry_date >= $2 AND pe.entry_date <= $3
         ORDER BY pe.entry_date DESC, pe.id DESC LIMIT 500`, [ids, from, to]);
      const out = [];
      for (const pe of rows) {
        const { rows: pr } = await pool.query('SELECT * FROM payout_rows WHERE payout_entry_id = $1 ORDER BY id', [pe.id]);
        const { rows: cut } = await pool.query('SELECT percent FROM partner_cuts WHERE payout_entry_id = $1', [pe.id]);
        out.push({ ...stamp(pe), rows: pr, partnerPercent: cut[0] ? Number(cut[0].percent) : null });
      }
      return res.json({ entries: out, range: { from, to } });
    }

    const { rows } = await pool.query(
      `SELECT re.*, u.username, s.name AS store_name FROM report_entries re
       JOIN users u ON u.id = re.user_id JOIN stores s ON s.id = re.store_id
       WHERE re.store_id = ANY($1) AND re.entry_date >= $2 AND re.entry_date <= $3
       ORDER BY re.entry_date DESC, re.id DESC LIMIT 500`, [ids, from, to]);
    const out = [];
    for (const e of rows) {
      const { rows: cp } = await pool.query('SELECT * FROM customer_payouts WHERE report_entry_id = $1 ORDER BY id', [e.id]);
      out.push({ ...stamp(e), customerPayouts: cp });
    }
    res.json({ entries: out, range: { from, to } });
  } catch (e) { next(e); }
});

module.exports = router;

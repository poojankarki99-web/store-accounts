'use strict';

const { pool } = require('./db');

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

// Store totals. Net = IN - OUT - manager expenses. Withdrawn (payouts) is NEVER subtracted.
async function storeTotals(storeId, fromDate = null, toDate = null) {
  const dateFilter = (col) => {
    const conds = [];
    if (fromDate) conds.push(`${col} >= '${fromDate}'`);
    if (toDate) conds.push(`${col} <= '${toDate}'`);
    return conds.length ? 'AND ' + conds.join(' AND ') : '';
  };
  const rep = await pool.query(
    `SELECT COALESCE(SUM(in_amount),0) AS in_total, COALESCE(SUM(out_amount),0) AS out_total
     FROM report_entries WHERE store_id = $1 ${dateFilter('entry_date')}`, [storeId]);
  const exp = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS expense_total
     FROM manager_expenses WHERE store_id = $1 ${dateFilter('expense_date')}`, [storeId]);
  const pay = await pool.query(
    `SELECT COALESCE(SUM(pr.amount),0) AS withdrawn_total
     FROM payout_rows pr JOIN payout_entries pe ON pe.id = pr.payout_entry_id
     WHERE pe.store_id = $1 ${dateFilter('pe.entry_date')}`, [storeId]);
  const inTotal = num(rep.rows[0].in_total);
  const outTotal = num(rep.rows[0].out_total);
  const expenseTotal = num(exp.rows[0].expense_total);
  const withdrawnTotal = num(pay.rows[0].withdrawn_total);
  return { inTotal, outTotal, expenseTotal, withdrawnTotal, net: Math.round((inTotal - outTotal - expenseTotal) * 100) / 100 };
}

module.exports = { num, storeTotals };

'use strict';
/* Store Accounts — mobile-first SPA (vanilla JS) */

const S = {
  user: null,          // {id, username, role, stores:[...]}
  allStores: [],       // admin: every store
  selected: null,      // null | 'all' | storeId
  tab: 'reports',
  from: '', to: '',
};

const $ = (sel, el) => (el || document).querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try { data = await r.json(); } catch (_) {}
  if (!r.ok) throw new Error(data.error || ('Request failed (' + r.status + ')'));
  return data;
}

// Dual timezone rendering for a stored ISO timestamp
function fmtBoth(iso) {
  const d = new Date(iso);
  const f = (tz) => new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(d).replace(',', '');
  return { central: f('America/Chicago'), nepal: f('Asia/Kathmandu') };
}

// Timezone view: admin toggles central/nepal; manager sees nepal-primary + central;
// employee sees nepal only.
function tzView() {
  if (!S.user) return 'central';
  if (S.user.role === 'admin') return S.tz || 'central';
  if (S.user.role === 'manager') return 'nepal-both';
  return 'nepal';
}
function tzLabel() {
  const v = tzView();
  return (v === 'nepal' || v === 'nepal-both') ? 'Nepal Time' : 'Central Time';
}
// Bold uppercase stamp: DATE TIME — EMPLOYEE NAME, second timezone below when applicable
function stampHtml(iso, username) {
  const t = fmtBoth(iso);
  const v = tzView();
  const primary = (v === 'nepal' || v === 'nepal-both') ? t.nepal : t.central;
  let html = `<div class="stamp">${esc(primary)} — ${esc(username || '')}</div>`;
  if (v === 'both') html += `<div class="stamp-sm">Nepal: ${esc(t.nepal)}</div>`;
  if (v === 'nepal-both') html += `<div class="stamp-sm">Central: ${esc(t.central)}</div>`;
  return html;
}
// Single-line timestamp for alerts/audit, following the viewer's timezone
function tzStampLine(ts) {
  const v = tzView();
  if (v === 'nepal' || v === 'nepal-both') return `${esc(ts.nepal.datetime)} Nepal`;
  return `${esc(ts.central.datetime)} Central`;
}

function topbar() {
  const u = S.user;
  const roleLabel = u.role.charAt(0).toUpperCase() + u.role.slice(1);
  return `<div class="topbar"><div><h1>${esc(u.username)}</h1>
    <div class="who">${esc(roleLabel)}</div></div>
    <div><button onclick="go('changepw')">Password</button>
    <button onclick="logout()">Sign Out</button></div></div>`;
}

async function logout() {
  try { await api('POST', '/api/auth/logout'); } catch (_) {}
  location.reload();
}

function go(view) {
  S.view = view;
  render();
}

/* ---------------- Boot ---------------- */
async function boot() {
  try {
    const { user } = await api('GET', '/api/auth/me');
    S.user = user;
    if (user.role === 'admin') {
      const { stores } = await api('GET', '/api/admin/stores');
      S.allStores = stores;
    }
  } catch (_) { S.user = null; }
  render();
}

function myStores() {
  return S.user.role === 'admin' ? S.allStores : (S.user.stores || []);
}

function render() {
  const app = $('#app');
  if (!S.user) return void (app.innerHTML = viewLogin());
  if (S.user.role === 'employee') {
    app.innerHTML = topbar() + `<div class="page">${employeeView()}</div>`;
  } else {
    app.innerHTML = topbar() + tabsHtml() + `<div class="page" id="tabbody"></div>`;
    renderTab();
  }
  afterRender();
  window.scrollTo(0, 0);
}

function afterRender() {
  if (!S.user || S.user.role !== 'employee') return;
  if (S.view === 'reportEntry') initReportForm();
  if (S.view === 'payoutEntry') initPayoutForm();
}

/* ---------------- Login ---------------- */
function viewLogin() {
  return `<div class="login-wrap"><div class="login-card">
    <h1>Store Accounts</h1><div class="sub">Sign in to your account</div>
    <div id="loginErr"></div>
    <label>Username</label><input id="li_user" autocomplete="username" placeholder="Enter your username">
    <label>Password</label><input id="li_pass" type="password" autocomplete="current-password" placeholder="Enter your password">
    <button class="btn" onclick="doLogin()">Login</button>
    <div class="sub" style="margin-top:12px">admin, manager, and employee logins supported</div>
  </div></div>`;
}

async function doLogin() {
  const errBox = $('#loginErr');
  errBox.innerHTML = '';
  try {
    const { user } = await api('POST', '/api/auth/login', {
      username: $('#li_user').value, password: $('#li_pass').value,
    });
    S.user = user;
    if (user.role === 'admin') {
      const { stores } = await api('GET', '/api/admin/stores');
      S.allStores = stores;
    }
    S.selected = null; S.tab = 'reports';
    render();
  } catch (e) { errBox.innerHTML = `<div class="error">${esc(e.message)}</div>`; }
}

/* ---------------- Employee ---------------- */
function employeeView() {
  if (S.view === 'reportEntry') return reportEntryForm();
  if (S.view === 'payoutEntry') return payoutEntryForm();
  if (S.view === 'changepw') return changePwForm();
  return `<div class="card"><h2>What would you like to do?</h2>
    <button class="big-choice" onclick="go('reportEntry')">📝 Report Entry</button>
    <button class="big-choice" onclick="go('payoutEntry')">💸 Payout Entry</button></div>`;
}

function storePicker() {
  const stores = myStores();
  if (stores.length <= 1) {
    return `<input type="hidden" id="f_store" value="${stores[0] ? stores[0].id : ''}">`;
  }
  return `<label>Store</label><select id="f_store">${
    stores.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')
  }</select>`;
}

function reportEntryForm() {
  const hours = Array.from({ length: 25 }, (_, i) => `<option value="${i}">${i}</option>`).join('');
  const mins = Array.from({ length: 60 }, (_, i) => `<option value="${i}">${String(i).padStart(2, '0')}</option>`).join('');
  return `<div class="card"><h2>Report Entry</h2><div id="f_err"></div>
    ${storePicker()}
    <label>Hours Worked Today</label>
    <div class="row2"><select id="f_hours">${hours}</select><select id="f_mins">${mins}</select></div>
    <div class="row2"><div><label>Hours</label></div><div><label>Minutes</label></div></div>
    <label>IN</label><input id="f_in" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0.00">
    <div class="figure"><span class="k">Net (IN − Customer Payout)</span><span class="v" id="f_net">0.00</span></div>
    <div class="section-title">Customer Out</div>
    <div id="custRows"></div>
    <button class="btn secondary" onclick="addCustRow()">+ Add More</button>
    <div class="final-notice">All Entries are Final and cannot be edited</div>
    <button class="btn" onclick="submitReport()">Submit Entry</button>
    <button class="btn secondary" onclick="go('home')">Back</button>
  </div>`;
}

function custRowHtml() {
  return `<div class="payout-row">
    <label>Customer Name</label><input class="c_name" placeholder="Name">
    <label>Game Name</label><input class="c_game" placeholder="Game">
    <label>Amount</label><input class="c_amt" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0.00">
  </div>`;
}
function addCustRow() { $('#custRows').insertAdjacentHTML('beforeend', custRowHtml()); }
function initReportForm() {
  const box = $('#custRows'); box.innerHTML = custRowHtml() + custRowHtml();
  const upd = () => {
    const custTotal = [...document.querySelectorAll('#custRows .c_amt')]
      .reduce((s, el) => s + (parseFloat(el.value) || 0), 0);
    const net = (parseFloat($('#f_in').value) || 0) - custTotal;
    $('#f_net').textContent = money(net);
  };
  $('#f_in').addEventListener('input', upd);
  box.addEventListener('input', upd);
}

async function submitReport() {
  const errBox = $('#f_err'); errBox.innerHTML = '';
  try {
    const rows = [...document.querySelectorAll('#custRows .payout-row')].map((el) => ({
      customerName: $('.c_name', el).value, gameName: $('.c_game', el).value, amount: $('.c_amt', el).value,
    })).filter((r) => r.customerName || r.gameName || r.amount);
    await api('POST', '/api/entries/report', {
      storeId: $('#f_store').value,
      hours: $('#f_hours').value, minutes: $('#f_mins').value,
      inAmount: $('#f_in').value,
      customerPayouts: rows,
    });
    S.view = 'home'; render();
    alert('Entry submitted.');
  } catch (e) { errBox.innerHTML = `<div class="error">${esc(e.message)}</div>`; }
}

function payoutEntryForm() {
  return `<div class="card"><h2>Enter Payout Details</h2><div id="f_err"></div>
    ${storePicker()}
    <div id="payRows"></div>
    <button class="btn secondary" onclick="addPayRow()">+ Add More</button>
    <div class="final-notice">All Entries are Final and cannot be edited</div>
    <button class="btn" onclick="submitPayout()">Submit Entry</button>
    <button class="btn secondary" onclick="go('home')">Back</button>
  </div>`;
}

function payRowHtml() {
  return `<div class="payout-row">
    <label>Name</label><input class="p_name" placeholder="Name">
    <label>Tag / Email</label><input class="p_tag" placeholder="Tag or email">
    <label>Amount</label><input class="p_amt" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0.00">
  </div>`;
}
function addPayRow() { $('#payRows').insertAdjacentHTML('beforeend', payRowHtml()); }
function initPayoutForm() { $('#payRows').innerHTML = payRowHtml(); }

async function submitPayout() {
  const errBox = $('#f_err'); errBox.innerHTML = '';
  try {
    const rows = [...document.querySelectorAll('#payRows .payout-row')].map((el) => ({
      name: $('.p_name', el).value, tagEmail: $('.p_tag', el).value, amount: $('.p_amt', el).value,
    })).filter((r) => r.name || r.tagEmail || r.amount);
    await api('POST', '/api/entries/payout', { storeId: $('#f_store').value, rows });
    S.view = 'home'; render();
    alert('Payout submitted.');
  } catch (e) { errBox.innerHTML = `<div class="error">${esc(e.message)}</div>`; }
}

function changePwForm() {
  return `<div class="card"><h2>Change Password</h2><div id="pw_err"></div>
    <div class="muted">Minimum 4 characters, letters and numbers only.</div>
    <label>Current Password</label><input id="pw_cur" type="password" autocomplete="current-password">
    <label>New Password</label><input id="pw_new" type="password" autocomplete="new-password">
    <button class="btn" onclick="doChangePw()">Change Password</button>
    <button class="btn secondary" onclick="go('home')">Back</button></div>`;
}
async function doChangePw() {
  const errBox = $('#pw_err'); errBox.innerHTML = '';
  try {
    await api('POST', '/api/auth/change-password', { currentPassword: $('#pw_cur').value, newPassword: $('#pw_new').value });
    errBox.innerHTML = `<div class="success">Password changed.</div>`;
  } catch (e) { errBox.innerHTML = `<div class="error">${esc(e.message)}</div>`; }
}

/* ---------------- Staff (admin / manager) ---------------- */
function tabsHtml() {
  const tabs = [
    ['reports', 'Reports'],
    ['holding', 'Holding'],
    ['expenses', 'Expenses'],
    ['cih', 'CIH Report'],
    ['team', 'Team'],
  ];
  if (S.user.role === 'admin') tabs.push(['alerts', 'Alerts'], ['audit', 'Edit Log']);
  return `<div class="tabs">${tabs.map(([k, label]) =>
    `<button class="${S.tab === k ? 'active' : ''}" onclick="setTab('${k}')">${label}</button>`).join('')}</div>`;
}
function setTab(t) { S.tab = t; render(); }

function storeName(id) {
  const s = myStores().find((x) => String(x.id) === String(id));
  return s ? s.name : '';
}

// No report data until a store is selected. Admins get the combined option; managers pick assigned stores only.
function storeSelectorHtml() {
  const stores = myStores();
  const opts = stores.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  const allOpt = S.user.role === 'admin' ? `<option value="all">All Stores (combined)</option>` : '';
  return `<div class="card"><h2>Select a Store</h2>
    <div class="muted">Choose a store to view its reports.</div>
    <label>Store</label>
    <select id="sel_store"><option value="">— Select —</option>${opts}${allOpt}</select>
    <button class="btn" onclick="pickStore()">View Reports</button></div>`;
}
function pickStore() {
  const v = $('#sel_store').value;
  if (!v) return;
  S.selected = v;
  render();
}

function renderTab() {
  const body = $('#tabbody');
  if (!body) return;
  if (S.view === 'changepw') { body.innerHTML = changePwForm(); return; }
  if (!S.selected) { body.innerHTML = storeSelectorHtml(); return; }
  if (S.tab === 'holding' && S.selected === 'all') {
    body.innerHTML = `<div class="card"><h2>Holding Balance</h2>
      <div class="muted">Holding Balance is shown per individual store only. Pick a single store above.</div>
      <button class="btn secondary" onclick="S.selected=null;render()">Choose Store</button></div>`;
    return;
  }
  ({ reports: tabReports, holding: tabHolding, expenses: tabExpenses, cih: tabCih, team: tabTeam, alerts: tabAlerts, audit: tabAudit })[S.tab](body);
}

function storeBarHtml() {
  const label = S.selected === 'all' ? 'All Stores' : storeName(S.selected);
  return `<div class="card"><div class="figure"><span class="k">Viewing</span><span class="v" style="font-size:16px">${esc(label)}</span></div>
    <button class="btn secondary small" onclick="S.selected=null;render()">Change Store</button></div>`;
}

/* ---------- Reports tab ---------- */
async function tabReports(body) {
  body.innerHTML = storeBarHtml() + `<div class="card"><h2>Reports</h2><div class="muted">Loading…</div></div>`;
  try {
    const q = new URLSearchParams({ store: S.selected });
    if (S.from) q.set('from', S.from);
    if (S.to) q.set('to', S.to);
    const d = await api('GET', '/api/reports/dashboard?' + q.toString());
    const { incomeExpense, outBreakdown, netProfit, withdrawnToday, expenses, range } = d;
    const mode = reportMode();
    // Label under the big number: month name for month view, else the date range
    const rangeLabel = mode === 'month'
      ? monthNameLabel(range.from)
      : (range.from === range.to ? range.from : `${range.from} → ${range.to}`);

    // Group report entries + their customer payouts per employee
    const cpByEntry = {};
    for (const c of (d.customerPayouts || [])) {
      (cpByEntry[c.report_entry_id] = cpByEntry[c.report_entry_id] || []).push(c);
    }
    const byEmp = {};
    for (const e of incomeExpense.inSection.entries) {
      const u = e.username || 'Unknown';
      const g = (byEmp[u] = byEmp[u] || { inTotal: 0, outTotal: 0, entries: [] });
      g.entries.push(e);
      g.inTotal = Math.round((g.inTotal + Number(e.in_amount)) * 100) / 100;
      for (const c of (cpByEntry[e.id] || [])) {
        g.outTotal = Math.round((g.outTotal + Number(c.amount)) * 100) / 100;
      }
    }
    const empHtml = Object.keys(byEmp).sort().map((u) => {
      const g = byEmp[u];
      const entryHtml = g.entries.map((e) => {
        const cps = (cpByEntry[e.id] || []).map((c) =>
          `<div class="meta">→ ${esc(c.customer_name)} · ${esc(c.game_name)} · <b>${money(c.amount)}</b></div>`).join('');
        return `<div class="item">${stampHtml(e.created_at, e.username)}
          <div>IN: <b>${money(e.in_amount)}</b> · Net: <b>${money(e.net_amount)}</b></div>
          ${cps}</div>`;
      }).join('');
      return `<div class="emp-name">${esc(u)}</div>
        <div class="figure"><span class="k">Total IN</span><span class="v pos">${money(g.inTotal)}</span></div>
        <div class="figure"><span class="k">Total Out</span><span class="v">${money(g.outTotal)}</span></div>
        ${entryHtml}`;
    }).join('') || '<div class="muted">No entries in range.</div>';

    const payoutRows = incomeExpense.payoutSection.entries.map((pe) => `
      <div class="item">${stampHtml(pe.created_at, pe.username)}
        ${pe.rows.map((r) => `<div>${esc(r.name)} · <span class="stamp-sm">${esc(r.tag_email)}</span> · <b>${money(r.amount)}</b></div>`).join('')}
      </div>`).join('') || '<div class="muted">No payouts in range.</div>';

    body.innerHTML = storeBarHtml() + `
    <div class="card net-hero"><h2>Net Profit</h2>
      <div class="net-hero-amount ${netProfit < 0 ? 'neg' : 'pos'}">${money(netProfit)}</div>
      <div class="muted">${esc(rangeLabel)}</div>
    </div>
    <div class="card"><h2>Reports</h2>
      <div class="cal-row">
        <div><label>From</label><input type="date" id="r_from" value="${esc(range.from)}" onchange="applyRange()"></div>
        <div><label>To</label><input type="date" id="r_to" value="${esc(range.to)}" onchange="applyRange()"></div>
      </div>
      <button class="btn ${mode === 'today' ? '' : 'secondary'}" onclick="todayRange()">Today</button>
      <button class="btn ${mode === 'month' ? '' : 'secondary'}" onclick="clearRange()">This Month</button>
      <button class="btn ${mode === 'all' ? '' : 'secondary'}" onclick="allTime()">All Time</button>
      ${S.user.role === 'admin' ? `<div class="row2" style="margin-top:8px">
        <button class="btn ${tzView() === 'central' ? '' : 'secondary'}" onclick="S.tz='central';render()">Central Time</button>
        <button class="btn ${tzView() === 'nepal' ? '' : 'secondary'}" onclick="S.tz='nepal';render()">Nepal Time</button>
      </div>` : ''}
      <div class="muted" style="margin-top:8px">Net Profit defaults to the entire month. All Time shows the current year.</div>
    </div>
    <div class="card"><h2>Income &amp; Expense (${esc(range.from)} → ${esc(range.to)})</h2>
      ${empHtml}
    </div>
    <div class="card"><h2>Payout (${esc(range.from)} → ${esc(range.to)})</h2>
      <div class="figure"><span class="k">Total Payout</span><span class="v">${money(incomeExpense.payoutSection.total)}</span></div>
      ${payoutRows}
    </div>
    ${withdrawnToday ? `<div class="card"><h2>Withdrawn Balance for the Day</h2>
      <div class="figure"><span class="k">${esc(withdrawnToday.date)}</span><span class="v">${money(withdrawnToday.total)}</span></div></div>` : ''}
    <div class="card"><h2>Expenses (${esc(range.from)} → ${esc(range.to)})</h2>
      ${expenses.map((e) => `<div class="item">${stampHtml(e.created_at, e.username)}
        <div><b>${money(e.amount)}</b> · ${esc(e.category)}${e.description ? ' · ' + esc(e.description) : ''}</div>
        <div class="meta">Date: ${esc(e.expense_date)}</div></div>`).join('') || '<div class="muted">None.</div>'}
    </div>
    `;
  } catch (e) {
    body.innerHTML = storeBarHtml() + `<div class="card"><div class="error">${esc(e.message)}</div></div>`;
  }
}
function applyRange() { S.from = $('#r_from').value; S.to = $('#r_to').value; render(); }
function clearRange() { S.from = ''; S.to = ''; render(); }
function centralTodayKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function centralYearKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric' }).format(new Date());
}
// "2026-10-15" -> "October 2026" (for the month label under Net Profit)
function monthNameLabel(ymd) {
  const [y, m] = String(ymd).split('-');
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${names[Number(m) - 1] || ''} ${y}`.trim();
}
// Which report view is active: 'custom' | 'today' | 'month' | 'all'
function reportMode() {
  if (!S.from && !S.to) return 'month';
  const t = centralTodayKey();
  if (S.from === t && S.to === t) return 'today';
  const y = centralYearKey();
  if (S.from === `${y}-01-01` && S.to === `${y}-12-31`) return 'all';
  return 'custom';
}
// "Today" shows only today's report (Central Time).
function todayRange() {
  const t = centralTodayKey();
  S.from = t; S.to = t;
  render();
}
// "All Time" shows the yearly report only: current Central calendar year.
function allTime() {
  const y = centralYearKey();
  S.from = `${y}-01-01`; S.to = `${y}-12-31`;
  render();
}

/* ---------- Holding tab (single store only) ---------- */
let Hmonth = '';     // YYYY-MM ('' = current Central month)
let Hstart = '', Hend = '';
let HrangeData = null;
async function tabHolding(body) {
  body.innerHTML = storeBarHtml() + `<div class="card"><h2>Holding Balance</h2><div class="muted">Loading…</div></div>`;
  try {
    const canCut = S.user.role === 'manager';
    // --- Month report (always shown) ---
    const mq = new URLSearchParams({ store: S.selected, mode: 'month' });
    if (Hmonth) mq.set('month', Hmonth);
    const m = await api('GET', '/api/reports/holding?' + mq.toString());
    Hmonth = m.period.month || '';

    const monthCard = `
    <div class="card"><h2>Holding Balance — ${esc(storeName(S.selected))}</h2>
      <div class="row2"><input type="month" id="h_month" value="${esc(m.period.month)}">
        <button class="btn small" onclick="Hmonth=$('#h_month').value;HrangeData=null;render()">Show</button>
        <button class="btn small secondary" onclick="Hmonth='';HrangeData=null;render()">This Month</button></div>
      <div class="figure" style="margin-top:12px"><span class="k">Holding Balance (${esc(m.period.label)})</span>
        <span class="v ${m.holdingBalance < 0 ? 'neg' : 'pos'}">${money(m.holdingBalance)}</span></div>
      <div class="figure"><span class="k">Total Withdrawn Amount (${esc(m.period.label)})</span>
        <span class="v">${money(m.totalWithdrawn)}</span></div>
      <div class="muted">${tzLabel()}</div>
    </div>
    <div class="card"><h2>Payout Entries — ${esc(m.period.label)}</h2>${payoutDetailHtml(m, canCut)}</div>
    <div class="card"><h2>Report With Details</h2>
      <div class="section-title">With Drawn Amount</div>${withdrawnDetailHtml(m) || '<div class="muted">None.</div>'}
    </div>
    <div class="card"><h2>Report Entries — ${esc(m.period.label)}</h2>${entryRowsHtml(m)}</div>`;

    // --- Custom date range (optional, below the month report) ---
    let rangeCard;
    if (!HrangeData) {
      rangeCard = `
      <div class="card"><h2>Custom Date Range</h2>
        <div class="row2"><div><label>Start Date</label><input type="date" id="h_start" value="${esc(Hstart)}"></div>
          <div><label>End Date</label><input type="date" id="h_end" value="${esc(Hend)}"></div></div>
        <button class="btn" onclick="showHoldingRange()">Show Range</button>
        <div class="muted" style="margin-top:8px">Pick a start and end date to see this store's holding figures for that period.</div>
      </div>`;
    } else {
      const r = HrangeData;
      rangeCard = `
      <div class="card"><h2>Holding — Custom Range (${esc(r.period.label)})</h2>
        <div class="row2"><div><label>Start Date</label><input type="date" id="h_start" value="${esc(r.period.start)}"></div>
          <div><label>End Date</label><input type="date" id="h_end" value="${esc(r.period.end)}"></div></div>
        <div class="row2" style="margin-top:8px">
          <button class="btn small" onclick="showHoldingRange()">Show Range</button>
          <button class="btn small secondary" onclick="HrangeData=null;Hstart='';Hend='';render()">Clear</button></div>
        <div class="figure" style="margin-top:12px"><span class="k">Holding Balance (${esc(r.period.label)})</span>
          <span class="v ${r.holdingBalance < 0 ? 'neg' : 'pos'}">${money(r.holdingBalance)}</span></div>
        <div class="figure"><span class="k">Total Withdrawn Amount (${esc(r.period.label)})</span>
          <span class="v">${money(r.totalWithdrawn)}</span></div>
        <div class="muted">${tzLabel()}</div>
      </div>
      <div class="card"><h2>Payout Entries — ${esc(r.period.label)}</h2>${payoutDetailHtml(r, canCut)}</div>
      <div class="card"><h2>Report Entries — ${esc(r.period.label)}</h2>${entryRowsHtml(r)}</div>`;
    }

    body.innerHTML = storeBarHtml() + monthCard + rangeCard;
  } catch (e) {
    body.innerHTML = storeBarHtml() + `<div class="card"><div class="error">${esc(e.message)}</div></div>`;
  }
}
async function showHoldingRange() {
  Hstart = $('#h_start').value; Hend = $('#h_end').value;
  try {
    const q = new URLSearchParams({ store: S.selected, mode: 'range', start: Hstart, end: Hend });
    HrangeData = await api('GET', '/api/reports/holding?' + q.toString());
  } catch (e) {
    HrangeData = null;
    const card = document.querySelector('#tabbody .card:last-child');
    if (card) card.insertAdjacentHTML('beforeend', `<div class="error">${esc(e.message)}</div>`);
    return;
  }
  render();
}
function payoutDetailHtml(d, canCut) {
  return d.details.map((pe) => `
    <div class="item">${stampHtml(pe.created_at, pe.username)}
      ${pe.rows.map((r) => `<div>${esc(r.name)} · <span class="stamp-sm">${esc(r.tag_email)}</span> · <b>${money(r.amount)}</b></div>`).join('')}
      <div class="meta">Entry total: <b>${money(pe.entryTotal)}</b></div>
      ${pe.partnerPercent !== null
        ? `<div>Partner cut: <b>${pe.partnerPercent}%</b> · Hand Balance (cash in hand): <b>${money(pe.handBalance)}</b></div>`
        : `<div class="muted">No partner percent entered yet.</div>`}
      ${canCut ? `<div class="row2" style="margin-top:6px"><input type="number" id="cut_${pe.id}" min="0" max="100" step="0.01" placeholder="% cut" value="${pe.partnerPercent ?? ''}">
        <button class="btn small" onclick="saveCut(${pe.id})">Save %</button></div>` : ''}
    </div>`).join('') || '<div class="muted">No payout entries in this period.</div>';
}
function withdrawnDetailHtml(d) {
  return d.details.map((pe) => `
    <div class="item"><b>${money(pe.entryTotal)}</b>
      ${pe.rows.map((r) => `<div class="stamp-sm">${esc(r.name)} · ${esc(r.tag_email)} · ${money(r.amount)}</div>`).join('')}
    </div>`).join('');
}
function entryRowsHtml(d) {
  return d.entries.map((e) => `
    <div class="item">${stampHtml(e.created_at, e.username)}
      <div>IN: <b>${money(e.in_amount)}</b> · Net: <b>${money(e.net_amount)}</b></div>
    </div>`).join('') || '<div class="muted">No entries in this period.</div>';
}
async function saveCut(peId) {
  const v = $('#cut_' + peId).value;
  try {
    await api('POST', '/api/manager/partner-cut', { payoutEntryId: peId, percent: v });
    render();
  } catch (e) { alert(e.message); }
}

// Store picker for staff forms: when "All Stores" is selected, force choosing one.
function staffStoreSelect(id) {
  if (S.selected !== 'all') return `<input type="hidden" id="${id}" value="${esc(S.selected)}">`;
  const stores = myStores();
  return `<label>Store</label><select id="${id}">${
    stores.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')
  }</select>`;
}

/* ---------- Expenses tab ---------- */
async function tabExpenses(body) {
  const isMgr = S.user.role === 'manager';
  body.innerHTML = storeBarHtml() + `
  ${isMgr || S.user.role === 'admin' ? `<div class="card"><h2>Add Expense</h2><div id="e_err"></div>
    ${staffStoreSelect('e_store')}
    <label>Amount</label><input id="e_amt" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0.00">
    <label>Category</label><input id="e_cat" placeholder="e.g. Rent, Utilities, Supplies">
    <label>Description (optional)</label><input id="e_desc" placeholder="Details">
    <label>Date</label><input id="e_date" type="date">
    <button class="btn" onclick="addExpense()">Add Expense</button></div>` : ''}
  <div class="card"><h2>Monthly Expenses</h2><div id="e_list" class="muted">Loading…</div></div>`;
  await loadExpenseList();
}
async function loadExpenseList() {
  try {
    const { expenses } = await api('GET', '/api/manager/expenses?store=' + encodeURIComponent(S.selected));
    $('#e_list').innerHTML = expenses.map((e) => `<div class="item">${stampHtml(e.created_at, e.username)}
      <div><b>${money(e.amount)}</b> · ${esc(e.category)}${e.description ? ' · ' + esc(e.description) : ''} · ${esc(e.store_name || '')}</div>
      <div class="meta">Date: ${esc(e.expense_date)}</div></div>`).join('')
      || '<div class="muted">No expenses.</div>';
  } catch (e) { $('#e_list').innerHTML = `<div class="error">${esc(e.message)}</div>`; }
}
async function addExpense() {
  const errBox = $('#e_err'); errBox.innerHTML = '';
  try {
    await api('POST', '/api/manager/expenses', {
      storeId: $('#e_store').value,
      amount: $('#e_amt').value, category: $('#e_cat').value,
      description: $('#e_desc').value, date: $('#e_date').value,
    });
    $('#e_amt').value = $('#e_cat').value = $('#e_desc').value = '';
    await loadExpenseList();
  } catch (e) { errBox.innerHTML = `<div class="error">${esc(e.message)}</div>`; }
}

/* ---------- CIH Report tab ---------- */
let CIHmonth = ''; // YYYY-MM; default = last completed Central month
function lastCompletedMonthKey() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  let y = Number(parts.find((p) => p.type === 'year').value);
  let m = Number(parts.find((p) => p.type === 'month').value) - 1;
  if (m < 1) { m = 12; y -= 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}
async function tabCih(body) {
  body.innerHTML = storeBarHtml() + `<div class="card"><h2>CIH Report</h2><div class="muted">Loading…</div></div>`;
  try {
    if (!CIHmonth) CIHmonth = lastCompletedMonthKey();
    const q = new URLSearchParams({ store: S.selected, month: CIHmonth });
    const d = await api('GET', '/api/reports/cih?' + q.toString());
    CIHmonth = d.month;
    const label = S.selected === 'all' ? 'All Stores' : storeName(S.selected);

    const perStoreHtml = d.perStore ? d.perStore.map((p) => `
      <div class="item"><b>${esc(p.storeName)}</b>
        <div>Money Made: <b class="${p.moneyMade < 0 ? 'neg' : 'pos'}">${money(p.moneyMade)}</b>
        <span class="meta"> (Withdrawn ${money(p.withdrawn)} − Expenses ${money(p.expenseTotal)})</span></div>
      </div>`).join('') : '';

    const expenseHtml = d.expenses.map((e) => `
      <div class="item"><span class="cih-exp-amt">${money(e.amount)}</span>
        <span>${esc(e.description || e.category || '')}</span>
        <div class="meta">${esc(e.category)} · ${esc(e.expense_date)}${e.store_name ? ' · ' + esc(e.store_name) : ''}</div>
      </div>`).join('') || '<div class="muted">No expenses this month.</div>';

    body.innerHTML = storeBarHtml() + `
    <div class="card"><h2>CIH Report — ${esc(label)}</h2>
      <label>Month</label><input type="month" id="cih_month" value="${esc(d.month)}">
      <button class="btn" onclick="CIHmonth=$('#cih_month').value;render()">Show</button>
      <div class="figure" style="margin-top:12px"><span class="k">Money Made (${esc(d.month)})</span>
        <span class="v ${d.moneyMade < 0 ? 'neg' : 'pos'}">${money(d.moneyMade)}</span></div>
      <div class="muted">Withdrawn ${money(d.withdrawn)} − Expenses ${money(d.expenseTotal)} · ${tzLabel()}</div>
      ${d.perStore ? `<div class="section-title">Per Store</div>${perStoreHtml}` : ''}
    </div>
    <div class="card"><h2>Expenses — ${esc(d.month)}</h2>${expenseHtml}</div>`;
  } catch (e) {
    body.innerHTML = storeBarHtml() + `<div class="card"><div class="error">${esc(e.message)}</div></div>`;
  }
}

/* ---------- Team tab ---------- */
async function tabTeam(body) {
  if (S.user.role === 'admin') return tabTeamAdmin(body);
  const stores = myStores();
  body.innerHTML = storeBarHtml() + `<div class="card"><h2>Team — Create Employee</h2><div id="t_err"></div>
    <label>Username</label><input id="ne_user" placeholder="username" autocomplete="off">
    <label>Password</label><input id="ne_pass" placeholder="min 4 chars, letters/numbers" autocomplete="new-password">
    <label>Assign Stores</label><div>${stores.map((s) =>
      `<label class="checkline"><input type="checkbox" class="ne_store" value="${s.id}"> ${esc(s.name)}</label>`).join('') || '<div class="muted">No stores assigned.</div>'}</div>
    <button class="btn" onclick="mgrCreateEmployee()">Create Employee</button></div>
  <div class="card"><h2>Team — Reset Employee Passwords</h2><div id="t_list" class="muted">Loading…</div></div>`;
  try {
    const { employees } = await api('GET', '/api/manager/employees');
    $('#t_list').innerHTML = employees.map((e) => `
      <div class="item"><b>${esc(e.username)}</b>
        <div class="meta">${e.stores.map((s) => esc(s.name)).join(', ')}</div>
        <div class="row2" style="margin-top:6px">
          <input id="npw_${e.id}" placeholder="New password (min 4, A-Z 0-9)">
          <button class="btn small" onclick="mgrResetPw(${e.id})">Reset</button>
        </div></div>`).join('') || '<div class="muted">No employees in your stores.</div>';
  } catch (e) { $('#t_list').innerHTML = `<div class="error">${esc(e.message)}</div>`; }
}
async function mgrCreateEmployee() {
  const errBox = $('#t_err'); errBox.innerHTML = '';
  try {
    const storeIds = [...document.querySelectorAll('.ne_store:checked')].map((c) => Number(c.value));
    await api('POST', '/api/manager/employees', {
      username: $('#ne_user').value, password: $('#ne_pass').value, storeIds,
    });
    errBox.innerHTML = `<div class="success">Employee created.</div>`;
    $('#ne_user').value = ''; $('#ne_pass').value = '';
    document.querySelectorAll('.ne_store:checked').forEach((c) => (c.checked = false));
    await tabTeam($('#tabbody'));
  } catch (e) { errBox.innerHTML = `<div class="error">${esc(e.message)}</div>`; }
}
async function mgrResetPw(id) {
  const errBox = $('#t_err'); errBox.innerHTML = '';
  try {
    await api('POST', `/api/manager/employees/${id}/reset-password`, { password: $('#npw_' + id).value });
    errBox.innerHTML = `<div class="success">Password reset.</div>`;
  } catch (e) { errBox.innerHTML = `<div class="error">${esc(e.message)}</div>`; }
}

/* ---------- Team tab (admin) ---------- */
async function tabTeamAdmin(body) {
  body.innerHTML = storeBarHtml() + `
  <div class="card"><h2>Stores</h2><div id="tm_err"></div>
    <div id="storesList" class="muted">Loading…</div>
    <div class="section-title">Add Store</div>
    <label>Name</label><input id="ns_name" placeholder="Store name">
    <label>Location / Details</label><input id="ns_loc" placeholder="Location">
    <button class="btn" onclick="addStore()">Add Store</button></div>
  <div class="card"><h2>Users</h2><div id="usersList" class="muted">Loading…</div>
    <div class="section-title">Create User</div>
    <label>Username</label><input id="nu_name" placeholder="username" autocomplete="off">
    <label>Password</label><input id="nu_pw" placeholder="min 4 chars, letters/numbers" autocomplete="new-password">
    <label>Role</label><select id="nu_role"><option value="employee">employee</option><option value="manager">manager</option><option value="admin">admin</option></select>
    <label>Assign Stores (managers: pick many)</label><div id="nu_stores"></div>
    <button class="btn" onclick="addUser()">Create User</button></div>`;
  await loadTeamAdmin();
}
async function loadTeamAdmin() {
  try {
    const [{ stores }, { users }] = await Promise.all([
      api('GET', '/api/admin/stores'), api('GET', '/api/admin/users'),
    ]);
    S.allStores = stores;
    $('#storesList').innerHTML = stores.map((s) =>
      `<div class="item"><b>${esc(s.name)}</b><div class="meta">${esc(s.location || '')}</div></div>`).join('')
      || '<div class="muted">No stores yet.</div>';
    $('#nu_stores').innerHTML = stores.map((s) =>
      `<label class="checkline"><input type="checkbox" class="nu_store" value="${s.id}"> ${esc(s.name)}</label>`).join('');
    $('#usersList').innerHTML = users.map((u) => `
      <div class="item"><b>${esc(u.username)}</b> <span class="stamp-sm">${esc(u.role)}</span>
        <div class="meta">${u.stores.map((s) => esc(s.name)).join(', ') || 'no stores'}</div>
        <div class="row2" style="margin-top:6px">
          <input id="rpw_${u.id}" placeholder="New password">
          <button class="btn small" onclick="adminResetPw(${u.id})">Reset PW</button>
        </div>
        <div style="margin-top:6px"><span class="muted">Stores:</span>
          ${stores.map((s) => `<label class="checkline" style="display:inline-flex;margin-right:10px">
            <input type="checkbox" class="us_${u.id}" value="${s.id}" ${u.stores.some((x) => x.id === s.id) ? 'checked' : ''}> ${esc(s.name)}</label>`).join('')}
          <button class="btn small secondary" onclick="saveUserStores(${u.id})">Save Stores</button>
          ${u.id !== S.user.id ? `<button class="btn small danger" onclick="delUser(${u.id},'${esc(u.username)}')">Delete</button>` : ''}
        </div></div>`).join('') || '<div class="muted">No users.</div>';
  } catch (e) { $('#tm_err').innerHTML = `<div class="error">${esc(e.message)}</div>`; }
}
async function addStore() {
  try {
    await api('POST', '/api/admin/stores', { name: $('#ns_name').value, location: $('#ns_loc').value });
    $('#ns_name').value = $('#ns_loc').value = '';
    await loadTeamAdmin();
  } catch (e) { $('#tm_err').innerHTML = `<div class="error">${esc(e.message)}</div>`; }
}
async function addUser() {
  try {
    const storeIds = [...document.querySelectorAll('.nu_store:checked')].map((c) => Number(c.value));
    await api('POST', '/api/admin/users', {
      username: $('#nu_name').value, password: $('#nu_pw').value,
      role: $('#nu_role').value, storeIds,
    });
    $('#nu_name').value = $('#nu_pw').value = '';
    await loadTeamAdmin();
  } catch (e) { $('#tm_err').innerHTML = `<div class="error">${esc(e.message)}</div>`; }
}
async function adminResetPw(id) {
  try {
    await api('POST', `/api/admin/users/${id}/reset-password`, { password: $('#rpw_' + id).value });
    $('#tm_err').innerHTML = `<div class="success">Password updated.</div>`;
  } catch (e) { $('#tm_err').innerHTML = `<div class="error">${esc(e.message)}</div>`; }
}
async function saveUserStores(id) {
  try {
    const storeIds = [...document.querySelectorAll('.us_' + id + ':checked')].map((c) => Number(c.value));
    await api('PUT', `/api/admin/users/${id}`, { storeIds });
    $('#tm_err').innerHTML = `<div class="success">Stores updated.</div>`;
  } catch (e) { $('#tm_err').innerHTML = `<div class="error">${esc(e.message)}</div>`; }
}
async function delUser(id, username) {
  if (!confirm('Delete user ' + username + '?')) return;
  try { await api('DELETE', `/api/admin/users/${id}`); await loadTeamAdmin(); }
  catch (e) { $('#tm_err').innerHTML = `<div class="error">${esc(e.message)}</div>`; }
}

/* ---------- Alerts tab (admin) ---------- */
async function tabAlerts(body) {
  body.innerHTML = storeBarHtml() + `<div class="card"><h2>Alerts</h2><div id="al_list" class="muted">Loading…</div></div>`;
  try {
    const { alerts } = await api('GET', '/api/admin/alerts');
    $('#al_list').innerHTML = alerts.map((a) => `
      <div class="alert ${a.severity}" id="alert-${a.id}">${esc(a.text)}
        <div class="stamp-sm">${tzStampLine(a.timestamps)}</div>
        <button class="btn secondary small" onclick="resolveAlert(${a.id})">Resolved</button>
      </div>`).join('') || '<div class="muted">No edits yet.</div>';
  } catch (e) { $('#al_list').innerHTML = `<div class="error">${esc(e.message)}</div>`; }
}
async function resolveAlert(id) {
  try {
    await api('POST', '/api/admin/alerts/' + id + '/resolve', {});
    const el = document.getElementById('alert-' + id);
    if (el) el.remove();
  } catch (e) { alert(e.message); }
}

/* ---------- Edit log tab (admin) ---------- */
async function tabAudit(body) {
  body.innerHTML = storeBarHtml() + `<div class="card"><h2>Edit Log</h2><div id="au_list" class="muted">Loading…</div></div>`;
  try {
    const { audit } = await api('GET', '/api/admin/audit');
    $('#au_list').innerHTML = audit.map((a) => `
      <div class="audit-row">
        <div><b>${esc(a.edited_by_username)}</b> (${esc(a.edited_by_role)}) — <code>${esc(a.entry_type)} #${a.entry_id}</code> · <code>${esc(a.field_name)}</code></div>
        <div>${esc(a.old_value ?? '—')} → <b>${esc(a.new_value ?? '—')}</b></div>
        <div class="stamp-sm">${tzStampLine(a.timestamps)}</div>
      </div>`).join('') || '<div class="muted">No edits yet.</div>';
  } catch (e) { $('#au_list').innerHTML = `<div class="error">${esc(e.message)}</div>`; }
}

boot();

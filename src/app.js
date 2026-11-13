import * as B from './books.js';
import { readSpreadsheet, decodeText } from './sheet.js';
import { postEntry, reverseEntry, parseAmount, formatCents, validateEntry, ACCOUNT_TYPES } from './ledger.js';

const KEY = 'clearbooks.v3';
const $ = s => document.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = c => formatCents(c, 'EUR');
const eurBlank = c => (c ? eur(c) : '');
const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const dmy = iso => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
const amt = v => parseAmount(String(v ?? ''));

// ---------- state & transactional commits ----------
let books;
let tab = 'dash';
function save() { localStorage.setItem(KEY, JSON.stringify(B.serialize(books))); }
function load() {
  const raw = localStorage.getItem(KEY);
  if (raw) { try { books = B.loadBooks(JSON.parse(raw)); return; } catch (e) { alert('Saved data could not be loaded (' + e.message + '). Starting with empty books — restore a backup.'); } }
  books = B.createBooks();
}
/** Run a change atomically: if anything throws, roll back to the snapshot. */
function commit(fn, okMsg) {
  const snap = B.serialize(books);
  try {
    const r = fn();
    save();
    if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg);
    render();
    return r ?? true;
  } catch (e) {
    books = B.loadBooks(snap);
    toast(e.message, true);
    return false;
  }
}

let tt;
function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(tt); tt = setTimeout(() => (t.className = ''), 4000);
}
const acctName = code => books.ledger.accounts.find(a => a.code === code)?.name ?? code;
const acctOptions = (filter = () => true, sel = '') => books.ledger.accounts.filter(filter)
  .map(a => `<option value="${a.code}" ${a.code === sel ? 'selected' : ''}>${a.code} · ${esc(a.name)}</option>`).join('');
const isExpenseOrAsset = a => a.type === 'expense' || (a.type === 'asset' && !['1000', '1100', '1510'].includes(a.code));
const custName = id => books.customers.find(c => c.id === id)?.name ?? '?';
const vendName = id => books.vendors.find(v => v.id === id)?.name ?? '?';
const badge = s => `<span class="badge ${esc(s)}">${esc(s)}</span>`;

// ---------- dialog ----------
const dlg = $('#dlg');
function openDialog(html, onSubmit, onReady) {
  const f = $('#dlgForm');
  f.oninput = null; f.onchange = null; // don't leak handlers from a previous dialog
  f.innerHTML = html;
  f.onsubmit = e => {
    if (e.submitter?.value === 'cancel') return;
    e.preventDefault();
    if (onSubmit(f) !== false) dlg.close();
  };
  dlg.showModal();
  onReady?.(f);
}
const dlgButtons = (ok = 'Save') => `<div class="dlg-actions"><button value="cancel" formnovalidate>Cancel</button><button class="primary" value="ok">${ok}</button></div>`;

function printHtml(html) { $('#printArea').innerHTML = html; window.print(); }
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const csvCell = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
const toCsv = rows => rows.map(r => r.map(csvCell).join(',')).join('\n');
const centsStr = c => (c < 0 ? '-' : '') + Math.floor(Math.abs(c) / 100) + '.' + String(Math.abs(c) % 100).padStart(2, '0');

// ---------- tabs ----------
$$('.tabs button').forEach(b => b.addEventListener('click', () => { tab = b.dataset.tab; render(); }));
const views = {};
function render() {
  $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  const s = books.settings;
  $('#brandName').textContent = s.businessName;
  document.title = s.businessName;
  const logo = $('#brandLogo'); logo.hidden = !s.logoDataUrl; if (s.logoDataUrl) logo.src = s.logoDataUrl;
  const lp = $('#lockPill'); lp.hidden = !books.ledger.lockDate; lp.textContent = `🔒 Locked to ${dmy(books.ledger.lockDate)}`;
  const lb = localStorage.getItem(KEY + '.lastBackup');
  $('#lastBackup').textContent = lb ? `Last backup: ${dmy(lb)}.` : 'No backup taken yet.';
  $('#main').innerHTML = '';
  views[tab]();
}

// ======================= DASHBOARD =======================
views.dash = () => {
  const t = today(), d = B.dashboard(books, t), v = d.vat;
  const taxYear = Number(t.slice(0, 4)) - 1;
  const todo = [];
  if (!books.bankOpening) todo.push(`Set your <a href="#" data-go="settings">opening bank balance</a> so reconciliation starts from the right figure.`);
  if (!books.settings.address || !books.settings.iban) todo.push(`Add your address and IBAN in <a href="#" data-go="settings">Settings</a> so they appear on invoices.`);
  if (d.unmatched) todo.push(`${d.unmatched} bank line(s) to match — <a href="#" data-go="bank">go to Bank</a>.`);
  if (d.overdue.length) todo.push(`${d.overdue.length} overdue invoice(s) — <a href="#" data-go="invoices">chase payment</a>.`);
  if (d.billsDue.length) todo.push(`${d.billsDue.length} bill(s) due within 7 days — <a href="#" data-go="purchases">view</a>.`);
  todo.push(`Form 11 for ${taxYear} is due 31/10/${taxYear + 1} (later if you file and pay on ROS) — <a href="#" data-go="yearend">prepare extracts</a>.`);
  $('#main').innerHTML = `
    <div class="grid4">
      <div class="stat"><div class="k">Bank balance (books)</div><div class="v">${eur(d.bank)}</div><div class="s">${d.lastReconciled ? 'Reconciled to ' + dmy(d.lastReconciled) : 'Not reconciled yet'}</div></div>
      <div class="stat"><div class="k">Owed to you</div><div class="v">${eur(d.receivable)}</div><div class="s">${d.overdue.length ? `<span class="badge overdue">${d.overdue.length} overdue</span>` : 'Nothing overdue'}</div></div>
      <div class="stat"><div class="k">You owe</div><div class="v">${eur(d.payable)}</div><div class="s">${d.billsDue.length} due this week</div></div>
      <div class="stat"><div class="k">Profit ${t.slice(0, 4)} to date</div><div class="v">${eur(d.ytd.netProfit)}</div><div class="s">Income ${eur(d.ytd.totalIncome)} · Costs ${eur(d.ytd.totalExpenses)}</div></div>
    </div>
    <div class="split">
      <div class="card"><h2>To do</h2><ul class="check-list">${todo.map(x => `<li><span class="ic">•</span><span>${x}</span></li>`).join('')}</ul></div>
      <div class="card">
        <h2>VAT registration watch</h2>
        <p class="small muted">Not VAT registered. You must register once services turnover goes over ${eur(v.threshold)} in the current <i>or</i> previous calendar year.</p>
        <div class="row" style="justify-content:space-between;margin:0"><b>${v.year}: ${eur(v.current)}</b>${badge(v.status)}</div>
        <div class="meter ${v.status}"><div style="width:${Math.min(100, v.pct)}%"></div></div>
        <div class="small muted">${v.pct}% of threshold · ${v.year - 1}: ${eur(v.previous)}</div>
        ${v.status === 'exceeded' ? '<p class="status bad">Turnover is over the threshold. You must register for VAT within 30 days.</p>' : v.status === 'warning' ? '<p class="status warn">You\'re over 80% of the threshold. Plan for VAT registration.</p>' : ''}
      </div>
    </div>
    <div class="card"><div class="head"><h2>Recent invoices</h2><button class="primary" id="dNewInv">+ New invoice</button></div>${invoiceTable(books.invoices.slice(-5).reverse())}</div>`;
  $$('[data-go]').forEach(a => a.onclick = e => { e.preventDefault(); tab = a.dataset.go; render(); });
  $('#dNewInv').onclick = newInvoiceDialog;
  bindInvoiceRows();
};

// ======================= INVOICES =======================
function invoiceTable(list) {
  const t = today();
  if (!list.length) return '<div class="empty">No invoices yet.</div>';
  return `<table><thead><tr><th>No.</th><th>Date</th><th>Customer</th><th>Due</th><th>Status</th><th class="num">Total</th><th class="num">Balance</th></tr></thead><tbody>
    ${list.map(i => `<tr class="click" data-inv="${i.id}"><td><b>${esc(i.number)}</b></td><td>${dmy(i.date)}</td><td>${esc(custName(i.customerId))}</td><td>${dmy(i.dueDate)}</td>
    <td>${badge(B.invoiceStatus(i, t))}</td><td class="num">${eur(i.total)}</td><td class="num">${eurBlank(B.invoiceBalance(i))}</td></tr>`).join('')}</tbody></table>`;
}
function bindInvoiceRows() { $$('[data-inv]').forEach(r => r.onclick = () => invoiceDetail(Number(r.dataset.inv))); }

views.invoices = () => {
  const filter = views.invoices.filter || 'all', t = today();
  const list = books.invoices.filter(i => filter === 'all' || (filter === 'unpaid' ? B.invoiceBalance(i) > 0 : B.invoiceStatus(i, t) === filter)).reverse();
  $('#main').innerHTML = `<div class="card">
    <div class="head"><h2>Invoices</h2><div class="row" style="margin:0">
      <select id="invFilter">${['all', 'unpaid', 'overdue', 'paid', 'void'].map(f => `<option ${f === filter ? 'selected' : ''}>${f}</option>`).join('')}</select>
      <button id="manageCust">Customers</button><button class="primary" id="newInv">+ New invoice</button></div></div>
    ${invoiceTable(list)}</div>`;
  $('#invFilter').onchange = e => { views.invoices.filter = e.target.value; render(); };
  $('#newInv').onclick = newInvoiceDialog;
  $('#manageCust').onclick = () => { tab = 'customers'; render(); };
  bindInvoiceRows();
};

function customerFormHtml(c = {}) {
  const v = k => esc(c[k] ?? '');
  return `<div class="row"><label class="grow">Name (business or person) * <input name="name" required value="${v('name')}" autofocus></label><label class="grow">Contact person <input name="contactName" value="${v('contactName')}"></label></div>
    <div class="row"><label class="grow">Email <input name="email" type="email" value="${v('email')}"></label><label class="grow">Phone <input name="phone" value="${v('phone')}"></label></div>
    <div class="row"><label class="grow">Address <textarea name="address" placeholder="Street&#10;Town&#10;County">${v('address')}</textarea></label>
      <div><label>Eircode <input name="eircode" value="${v('eircode')}" size="9" placeholder="D02 X285"></label><br><label>Tax ref (PPSN / CRO / VAT) <input name="taxRef" value="${v('taxRef')}" size="14"></label></div></div>
    <label>Notes <textarea name="notes">${v('notes')}</textarea></label>`;
}
const readCustomerForm = f => Object.fromEntries(Object.keys(B.CUSTOMER_FIELDS).map(k => [k, f[k].value]));
function customerDialog(after, existing) {
  openDialog(`<h2>${existing ? 'Edit customer' : 'New customer'}</h2>${customerFormHtml(existing)}
    ${existing ? '<p class="small muted">Invoices you have already issued keep the customer details they were issued with.</p>' : ''}
    <div class="dlg-actions">${existing ? '<button type="button" class="danger" id="cDel" style="margin-right:auto">Delete</button>' : ''}<button value="cancel" formnovalidate>Cancel</button><button class="primary" value="ok">${existing ? 'Save' : 'Add customer'}</button></div>`,
  f => {
    const c = commit(() => existing ? B.updateCustomer(books, existing.id, readCustomerForm(f)) : B.addCustomer(books, readCustomerForm(f)), existing ? 'Customer updated' : 'Customer added');
    if (c && after) setTimeout(() => after(c));
    return !!c;
  },
  () => { $('#cDel') && ($('#cDel').onclick = () => { if (confirm(`Delete ${existing.name}?`) && commit(() => B.deleteCustomer(books, existing.id), 'Customer deleted')) dlg.close(); }); });
}

// ======================= CUSTOMERS =======================
views.customers = () => {
  const q = (views.customers.q || '').toLowerCase();
  const stats = new Map(books.customers.map(c => [c.id, { n: 0, owed: 0 }]));
  for (const i of books.invoices) { const st = stats.get(i.customerId); if (st && !i.voidJournalNo) { st.n++; st.owed += B.invoiceBalance(i); } }
  const list = books.customers.filter(c => !q || Object.keys(B.CUSTOMER_FIELDS).some(k => String(c[k] ?? '').toLowerCase().includes(q)))
    .sort((a, b) => a.name.localeCompare(b.name, 'en-IE'));
  $('#main').innerHTML = `<div class="card">
    <div class="head"><h2>Customers <span class="muted small">${books.customers.length}</span></h2><div class="row" style="margin:0">
      <input type="search" id="cq" placeholder="Search name, email, Eircode…" value="${esc(views.customers.q || '')}">
      <label class="button">⬆ Import Excel / CSV<input type="file" id="cImp" accept=".xlsx,.csv,.txt,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden></label>
      <button id="cExp" ${books.customers.length ? '' : 'disabled'}>⬇ Export</button>
      <button class="primary" id="cNew">+ Customer</button></div></div>
    ${books.customers.length ? '' : `<div class="option"><b>Have a customer list already?</b> Import it from Excel (.xlsx) or CSV. The columns are recognised automatically (name, contact, email, phone, address, Eircode, PPSN/CRO, notes), and you check everything before anything is saved.
      <div style="margin-top:8px"><button class="sm" id="cTpl">Download template</button></div></div>`}
    ${list.length ? `<table><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Eircode</th><th class="num">Invoices</th><th class="num">Owes you</th></tr></thead><tbody>
      ${list.map(c => { const st = stats.get(c.id); return `<tr class="click" data-c="${c.id}"><td><b>${esc(c.name)}</b>${c.contactName ? `<div class="small muted">${esc(c.contactName)}</div>` : ''}</td>
        <td>${esc(c.email)}</td><td>${esc(c.phone)}</td><td>${esc(c.eircode)}</td><td class="num">${st.n || ''}</td><td class="num">${eurBlank(st.owed)}</td></tr>`; }).join('')}
    </tbody></table>` : books.customers.length ? '<div class="empty">No customers match your search.</div>' : ''}
    ${books.customers.length ? '<p class="small muted"><a href="#" id="cTpl">Download import template</a></p>' : ''}</div>`;
  $('#cq').oninput = e => { views.customers.q = e.target.value; clearTimeout(views.customers.t); views.customers.t = setTimeout(() => { render(); const i = $('#cq'); i.focus(); i.setSelectionRange(99, 99); }, 200); };
  $('#cNew').onclick = () => customerDialog();
  $$('[data-c]').forEach(r => r.onclick = () => customerDialog(null, books.customers.find(c => c.id === Number(r.dataset.c))));
  $('#cExp').onclick = () => download(`customers-${today()}.csv`, '\uFEFF' + toCsv(B.customersToRows(books)), 'text/csv;charset=utf-8');
  $('#cTpl').onclick = e => { e.preventDefault(); download('customer-import-template.csv', '\uFEFF' + toCsv([Object.values(B.CUSTOMER_FIELDS),
    ['Ó Briain Plumbing Ltd', 'Seán Ó Briain', 'sean@obriain.ie', '087 123 4567', 'Unit 4, Kinsale Road\nCork', 'T12 XY34', '1234567T', 'Payroll weekly']]), 'text/csv;charset=utf-8'); };
  $('#cImp').onchange = async e => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    if (file.size > 5 * 1024 * 1024) return toast('File is larger than 5 MB', true);
    try {
      let rows = await readSpreadsheet(file.name, await file.arrayBuffer());
      while (rows.length && !rows[0].some(Boolean)) rows.shift(); // skip blank lines above the header
      if (rows.length < 2) throw new Error('No customer rows found. The first row should be the column headings.');
      importCustomersDialog(file.name, rows);
    } catch (err) { toast(err.message, true); }
  };
};

function importCustomersDialog(fileName, rows) {
  const headers = rows[0];
  const width = Math.max(...rows.slice(0, 50).map(r => r.length));
  const cols = B.detectCustomerColumns(Array.from({ length: width }, (_, i) => headers[i] ?? ''));
  const sample = i => rows.slice(1).map(r => r[i]).find(Boolean) ?? '';
  const opts = sel => `<option value="">— ignore —</option>${Object.entries(B.IMPORT_TARGETS).map(([k, l]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(l)}</option>`).join('')}`;
  openDialog(`<h2>Import customers</h2><p class="muted small">${esc(fileName)} · ${rows.length - 1} row(s). Check how the columns are matched, then review the preview. Nothing is saved until you click Import.</p>
    <h3>1. Match columns</h3>
    <div style="max-height:220px;overflow:auto"><table><thead><tr><th>Column in your file</th><th>Example</th><th>Import as</th></tr></thead><tbody>
      ${cols.map((c, i) => `<tr><td><b>${esc(headers[i] || `Column ${i + 1}`)}</b></td><td class="small muted">${esc(String(sample(i)).slice(0, 40))}</td><td><select data-col="${i}">${opts(c)}</select></td></tr>`).join('')}
    </tbody></table></div>
    <p class="small muted">Several columns can be imported as <b>Address</b> (for example street, town and county). They're joined on separate lines.</p>
    <h3>2. Customers that already exist (same name)</h3>
    <div class="row"><label class="check"><input type="radio" name="ex" value="skip" checked> Skip them</label><label class="check"><input type="radio" name="ex" value="update"> Update them with details from the file (blank cells don't erase anything)</label></div>
    <h3>3. Preview</h3><div id="impSum"></div><div id="impPrev" style="max-height:280px;overflow:auto"></div>
    <div class="dlg-actions"><button value="cancel" formnovalidate>Cancel</button><button class="primary" value="ok" id="impGo">Import</button></div>`,
  f => {
    const recs = prep(f); if (!recs) return false;
    return !!commit(() => B.applyCustomerImport(books, recs), r => `Imported: ${r.added} added${r.updated ? `, ${r.updated} updated` : ''}${r.skipped ? `, ${r.skipped} skipped` : ''}`);
  },
  f => { f.onchange = () => prep(f); prep(f); });

  function prep(f) {
    const mapping = $$('[data-col]', f).map(s => s.value);
    let recs;
    try { recs = B.prepareCustomerImport(books, rows, mapping, { onExisting: f.ex.value }); }
    catch (e) { $('#impSum').innerHTML = `<p class="status bad">${esc(e.message)}</p>`; $('#impPrev').innerHTML = ''; $('#impGo').disabled = true; return null; }
    const count = s => recs.filter(r => r.status === s).length;
    const n = count('new'), u = count('update'), bad = count('error') + count('duplicate'), sk = count('skip-existing');
    const label = { new: 'new', update: 'update', 'skip-existing': 'exists, skip', duplicate: 'duplicate', error: 'error' };
    const cls = { new: 'ok', update: 'open', 'skip-existing': '', duplicate: 'bad', error: 'bad' };
    $('#impSum').innerHTML = `<p class="status ${bad ? 'warn' : 'ok'}">${n} new · ${u} to update · ${sk} already exist (skipped)${bad ? ` · ${bad} with problems (not imported)` : ''}</p>`;
    $('#impPrev').innerHTML = `<table><thead><tr><th>Row</th><th>Name</th><th>Email</th><th>Phone</th><th>Eircode</th><th>Status</th></tr></thead><tbody>
      ${recs.slice(0, 300).map(r => `<tr><td class="muted">${r.rowNo}</td><td>${esc(r.data.name || '')}${r.data.address ? `<div class="small muted">${esc(r.data.address.replace(/\n/g, ', '))}</div>` : ''}</td><td>${esc(r.data.email || '')}</td><td>${esc(r.data.phone || '')}</td><td>${esc(r.data.eircode || '')}</td>
        <td><span class="badge ${cls[r.status]}">${label[r.status]}</span>${r.error ? `<div class="small" style="color:var(--bad)">${esc(r.error)}</div>` : ''}${r.warnings?.length ? `<div class="small" style="color:var(--warn)">${esc(r.warnings.join('; '))}</div>` : ''}</td></tr>`).join('')}
      </tbody></table>${recs.length > 300 ? `<p class="small muted">Showing the first 300 of ${recs.length} rows.</p>` : ''}`;
    $('#impGo').disabled = n + u === 0;
    $('#impGo').textContent = n + u ? `Import ${n + u} customer${n + u === 1 ? '' : 's'}` : 'Nothing to import';
    return recs;
  }
}

function newInvoiceDialog() {
  if (!books.customers.length) { toast('Add your first customer'); return customerDialog(() => newInvoiceDialog()); }
  const t = today();
  const due = B.addDays(t, books.settings.paymentTermsDays);
  openDialog(`<h2>New invoice <span class="muted small">${esc(books.settings.invoicePrefix + String(books.seq.invoice).padStart(4, '0'))}</span></h2>
    <div class="row">
      <label class="grow">Customer <select name="cust" required><option value="">Choose…</option>${books.customers.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
      <button type="button" id="addCust" class="sm">+ New</button>
      <label>Date <input type="date" name="date" value="${t}" required /></label>
      <label>Due <input type="date" name="due" value="${due}" required /></label>
    </div>
    <table class="lines"><thead><tr><th style="width:55%">Description</th><th class="num">Qty / hrs</th><th class="num">Rate €</th><th class="num">Amount</th><th></th></tr></thead><tbody id="items"></tbody></table>
    <div class="row" style="justify-content:space-between;margin-top:10px"><button type="button" id="addItem" class="sm">+ Add line</button>
      <div style="font-size:18px"><span class="muted">Total</span> <b id="invTotal">€0.00</b></div></div>
    <label>Notes on invoice <textarea name="notes">${esc(books.settings.invoiceNotes)}</textarea></label>
    <p id="invErr" class="small" style="color:var(--bad)"></p>${dlgButtons('Create invoice')}`,
  f => {
    let items;
    try { items = readItems(f); } catch (e) { toast(e.message, true); return false; }
    const inv = commit(() => B.createInvoice(books, { customerId: Number(f.cust.value), date: f.date.value, dueDate: f.due.value, items, notes: f.notes.value }),
      i => `Invoice ${i.number} created`);
    if (inv) setTimeout(() => invoiceDetail(inv.id));
    return !!inv;
  },
  f => {
    const add = () => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><input class="d" placeholder="e.g. Payroll processing — October" /></td><td class="num"><input class="q" value="1" inputmode="decimal" /></td>
        <td class="num"><input class="p" inputmode="decimal" placeholder="0.00" /></td><td class="num a"></td><td><button type="button" class="icon">×</button></td>`;
      tr.querySelector('.icon').onclick = () => { if ($$('#items tr').length > 1) { tr.remove(); recalc(); } };
      $('#items').appendChild(tr);
    };
    const recalc = () => {
      try {
        const items = readItems(f, true);
        const c = items.length ? B.computeInvoice(items) : { total: 0, items: [] };
        $$('#items tr').forEach((tr, i) => (tr.querySelector('.a').textContent = c.items[i] ? eur(c.items[i].amount) : ''));
        $('#invTotal').textContent = eur(c.total); $('#invErr').textContent = '';
      } catch (e) { $('#invErr').textContent = e.message; }
    };
    add(); f.oninput = recalc;
    $('#addItem').onclick = () => { add(); recalc(); };
    $('#addCust').onclick = () => { dlg.close(); customerDialog(() => newInvoiceDialog()); };
    f.date.onchange = () => (f.due.value = B.addDays(f.date.value, books.settings.paymentTermsDays));
  });
}
/** Read invoice lines, ignoring completely blank rows. */
function readItems(f) {
  return $$('#items tr', f).map(tr => ({ description: tr.querySelector('.d').value, qty: tr.querySelector('.q').value, unitPrice: tr.querySelector('.p').value }))
    .filter(it => it.description.trim() || it.unitPrice.trim());
}

function invoiceDocHtml(inv) {
  const s = books.settings, c = inv.customerSnapshot;
  const payLines = [s.iban && `IBAN: ${s.iban}`, s.bic && `BIC: ${s.bic}`].filter(Boolean).join('   ');
  return `<div class="inv-doc">
    <div class="top">
      <div>${s.logoDataUrl ? `<img src="${s.logoDataUrl}" alt="logo"><br>` : ''}<b style="font-size:17px">${esc(s.businessName)}</b><br>
        <span style="white-space:pre-line">${esc(s.address)}</span>${s.email ? '<br>' + esc(s.email) : ''}${s.phone ? '<br>' + esc(s.phone) : ''}${s.website ? '<br>' + esc(s.website) : ''}</div>
      <div style="text-align:right"><h1>INVOICE</h1><table class="meta" style="margin-left:auto">
        <tr><td>Invoice no.</td><td><b>${esc(inv.number)}</b></td></tr><tr><td>Date</td><td>${dmy(inv.date)}</td></tr><tr><td>Due</td><td>${dmy(inv.dueDate)}</td></tr></table></div>
    </div>
    <div style="margin-bottom:24px"><div class="muted small">BILL TO</div><b>${esc(c.name)}</b>${c.contactName ? `<br>Attn: ${esc(c.contactName)}` : ''}<br><span style="white-space:pre-line">${esc(c.address)}</span></div>
    <table class="items"><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
      <tbody>${inv.items.map(i => `<tr><td>${esc(i.description)}</td><td class="num">${i.qty}</td><td class="num">${eur(i.unitPrice)}</td><td class="num">${eur(i.amount)}</td></tr>`).join('')}</tbody>
      <tbody class="tot"><tr><td></td><td colspan="2" class="num">Total due</td><td class="num">${eur(inv.total)}</td></tr></tbody></table>
    <div class="foot">${inv.voidJournalNo ? '<b style="color:#c42b2b">VOID</b>\n' : ''}${payLines ? `<b>Payment details</b>\n${esc(s.businessName)}   ${esc(payLines)}\nPlease quote ${esc(inv.number)} as the reference.\n\n` : ''}${esc(inv.notes)}</div>
  </div>`;
}

function invoiceDetail(id) {
  const inv = books.invoices.find(i => i.id === id), t = today(), bal = B.invoiceBalance(inv), st = B.invoiceStatus(inv, t);
  openDialog(`<div class="head"><h2>${esc(inv.number)} ${badge(st)}</h2><div class="row" style="margin:0"><button type="button" id="pPrint">🖨 Print / PDF</button><button type="button" id="pEmail">✉ Email</button></div></div>
    <div style="border:1px solid var(--line);border-radius:10px;max-height:46vh;overflow:auto">${invoiceDocHtml(inv)}</div>
    ${inv.payments.length ? `<h3>Payments</h3><table>${inv.payments.map(p => `<tr><td>${dmy(p.date)}</td><td class="num">${eur(p.amount)}</td><td class="muted small">Journal #${p.journalNo}</td></tr>`).join('')}</table>` : ''}
    ${inv.writeOff ? `<p class="status warn">Written off ${eur(inv.writeOff.amount)} as a bad debt on ${dmy(inv.writeOff.date)}</p>` : ''}
    ${bal > 0 ? `<h3>Record payment received</h3><div class="row"><label>Date <input type="date" name="pdate" value="${t}"></label><label>Amount € <input name="pamt" value="${centsStr(bal)}" inputmode="decimal"></label>
      <button class="primary" value="ok">Record payment</button></div>
      <p class="small muted">Tip: if you import bank statements, apply the lodgement from the <b>Bank</b> tab instead. That records the payment and matches it in one step.</p>` : ''}
    <div class="dlg-actions">
      ${!inv.voidJournalNo && !inv.payments.length && !inv.writeOff ? '<button type="button" class="danger" id="pVoid">Void invoice</button>' : ''}
      ${bal > 0 && !inv.writeOff ? '<button type="button" class="danger" id="pWo">Write off as bad debt</button>' : ''}
      <button value="cancel" formnovalidate>Close</button></div>`,
  f => !!commit(() => B.recordInvoicePayment(books, id, { date: f.pdate.value, amount: amt(f.pamt.value) }), 'Payment recorded'),
  () => {
    $('#pPrint').onclick = () => printHtml(invoiceDocHtml(inv));
    $('#pEmail').onclick = () => {
      const c = inv.customerSnapshot;
      const body = `Hi ${c.name},\n\nPlease find attached invoice ${inv.number} for ${eur(inv.total)}, due ${dmy(inv.dueDate)}.\n\n${books.settings.iban ? `Payment by bank transfer to IBAN ${books.settings.iban}${books.settings.bic ? ' (BIC ' + books.settings.bic + ')' : ''}, reference ${inv.number}.\n\n` : ''}Kind regards,\n${books.settings.businessName}`;
      location.href = `mailto:${encodeURIComponent(c.email || '')}?subject=${encodeURIComponent(`Invoice ${inv.number} from ${books.settings.businessName}`)}&body=${encodeURIComponent(body)}`;
      toast('Use Print / PDF → "Save as PDF" to attach the invoice');
    };
    $('#pVoid') && ($('#pVoid').onclick = () => { if (confirm(`Void ${inv.number}? A reversing journal entry is posted, and the invoice number stays in the sequence marked VOID.`)) { dlg.close(); commit(() => B.voidInvoice(books, id, { date: t }), 'Invoice voided'); } });
    $('#pWo') && ($('#pWo').onclick = () => { if (confirm(`Write off ${eur(bal)} as a bad debt (Dr Bad Debts / Cr Debtors)?`)) { dlg.close(); commit(() => B.writeOffInvoice(books, id, { date: t }), 'Written off'); } });
  });
}

// ======================= PURCHASES =======================
views.purchases = () => {
  const t = today();
  const list = [...books.purchases].reverse();
  $('#main').innerHTML = `<div class="card"><div class="head"><h2>Purchases &amp; bills</h2><button class="primary" id="newP">+ Record purchase</button></div>
    ${list.length ? `<table><thead><tr><th>Ref</th><th>Date</th><th>Supplier</th><th>Category</th><th>Status</th><th class="num">Amount</th><th></th></tr></thead><tbody>
    ${list.map(p => { const st = B.purchaseStatus(p, t); return `<tr><td>${esc(p.number)}${p.reference ? `<div class="small muted">${esc(p.reference)}</div>` : ''}</td><td>${dmy(p.date)}</td><td>${esc(vendName(p.vendorId))}<div class="small muted">${esc(p.description)}</div></td>
      <td class="small">${esc(acctName(p.account))}</td><td>${badge(st)}${!p.paidImmediately && st !== 'paid' && st !== 'void' ? `<div class="small muted">due ${dmy(p.dueDate)}</div>` : ''}</td><td class="num">${eur(p.amount)}</td>
      <td class="num">${B.purchaseBalance(p) > 0 ? `<button class="sm" data-pay="${p.id}">Pay</button>` : ''} ${!p.voidJournalNo && !p.payments.length ? `<button class="sm ghost danger" data-void="${p.id}">Void</button>` : ''}</td></tr>`; }).join('')}
    </tbody></table>` : '<div class="empty">No purchases yet. Record receipts as you go, or categorise them from your bank statement.</div>'}</div>`;
  $('#newP').onclick = purchaseDialog;
  $$('[data-pay]').forEach(b => b.onclick = () => {
    const p = books.purchases.find(x => x.id === Number(b.dataset.pay));
    openDialog(`<h2>Pay ${esc(p.number)} — ${esc(vendName(p.vendorId))}</h2><div class="row"><label>Date <input type="date" name="d" value="${today()}"></label>
      <label>Amount € <input name="a" value="${centsStr(B.purchaseBalance(p))}"></label></div>${dlgButtons('Record payment')}`,
    f => !!commit(() => B.payBill(books, p.id, { date: f.d.value, amount: amt(f.a.value) }), 'Bill payment recorded'));
  });
  $$('[data-void]').forEach(b => b.onclick = () => { if (confirm('Void this purchase? A reversing entry is posted.')) commit(() => B.voidPurchase(books, Number(b.dataset.void), { date: today() }), 'Purchase voided'); });
};
function purchaseDialog(prefill = {}) {
  openDialog(`<h2>Record purchase</h2>
    <div class="row"><label class="grow">Supplier <input name="v" list="vendList" required value="${esc(prefill.vendor || '')}"><datalist id="vendList">${books.vendors.map(v => `<option value="${esc(v.name)}">`).join('')}</datalist></label>
      <label>Date <input type="date" name="d" value="${prefill.date || today()}" required></label></div>
    <div class="row"><label class="grow">Category <select name="acc" required>${acctOptions(isExpenseOrAsset, prefill.account || '5500')}</select></label>
      <label>Amount € <input name="a" inputmode="decimal" required value="${prefill.amount ? centsStr(prefill.amount) : ''}"></label></div>
    <div class="row"><label class="grow">Description <input name="desc" placeholder="e.g. Annual CTA subscription"></label><label>Receipt / invoice no. <input name="ref"></label></div>
    <div class="row"><label class="check"><input type="radio" name="paid" value="1" checked> Paid already (from bank)</label><label class="check"><input type="radio" name="paid" value="0"> Bill, pay later</label>
      <label id="dueL" hidden>Due <input type="date" name="due"></label></div>
    <p class="small muted">Equipment that will last several years (laptop, desk) → choose <b>1500 Computer &amp; Office Equipment</b>. You then claim wear &amp; tear instead of the full cost.</p>
    ${dlgButtons('Save purchase')}`,
  f => !!commit(() => B.recordPurchase(books, { vendor: f.v.value, date: f.d.value, account: f.acc.value, amount: amt(f.a.value), description: f.desc.value, reference: f.ref.value, paid: f.paid.value === '1', dueDate: f.due.value }), 'Purchase recorded'),
  f => { $$('[name=paid]', f).forEach(r => r.onchange = () => ($('#dueL').hidden = f.paid.value === '1')); });
}

// ======================= BANK =======================
views.bank = () => {
  const lines = [...books.statement].reverse();
  const un = books.statement.filter(s => !s.match).length;
  const last = B.lastReconciliation(books);
  $('#main').innerHTML = `
  <div class="card"><div class="head"><h2>Bank statement</h2><div class="row" style="margin:0">
    <select id="dfmt" title="Date format in your bank's CSV"><option value="DMY">DD/MM/YYYY</option><option value="MDY">MM/DD/YYYY</option></select>
    <label class="button">⬆ Import CSV<input type="file" id="csv" accept=".csv,text/csv" hidden></label>
    <button id="auto" ${un ? '' : 'disabled'}>⚡ Auto-match</button></div></div>
    <p class="small muted">Download a CSV from your bank (AIB, BOI, PTSB, Revolut and others) and import it here. Lines that are already imported are skipped. ${un ? `<b>${un} line(s) need attention.</b>` : ''}</p>
    ${lines.length ? `<table><thead><tr><th>Date</th><th>Description</th><th class="num">In</th><th class="num">Out</th><th>Status</th><th></th></tr></thead><tbody>
    ${lines.map(s => `<tr><td>${dmy(s.date)}</td><td>${esc(s.description)}${s.match ? `<div class="small muted">↔ ${esc(entryMemo(s.match))}</div>` : ''}</td>
      <td class="num">${s.amount > 0 ? eur(s.amount) : ''}</td><td class="num">${s.amount < 0 ? eur(-s.amount) : ''}</td>
      <td>${badge(s.reconciliationId ? 'reconciled' : s.match ? 'matched' : 'unmatched')}</td>
      <td class="num">${!s.match ? `<button class="sm primary" data-res="${s.id}">Resolve</button> <button class="sm icon" title="Delete line" data-del="${s.id}">×</button>` : !s.reconciliationId ? `<button class="sm ghost" data-un="${s.id}">Unmatch</button>` : ''}</td></tr>`).join('')}
    </tbody></table>` : '<div class="empty">No statement lines yet.</div>'}
  </div>
  <div class="card"><h2>Reconcile</h2>
    <p class="small muted">Enter the closing balance printed on your bank statement. ${last ? `Last reconciled to ${dmy(last.statementDate)} at ${eur(last.closingBalance)}.` : `Opening balance: ${eur(books.bankOpening?.amount ?? 0)}${books.bankOpening ? '' : ' (not set; see Settings)'}.`}</p>
    <div class="row"><label>Statement date <input type="date" id="rDate" value="${today()}"></label><label>Closing balance € <input id="rBal" inputmode="decimal" placeholder="e.g. -120.50 or 2,450.00"></label><button id="rPrev">Check</button></div>
    <div id="rOut"></div>
    ${books.reconciliations.length ? `<h3>History</h3><table><thead><tr><th>Statement date</th><th class="num">Opening</th><th class="num">Closing</th><th class="num">Items</th></tr></thead>
      <tbody>${[...books.reconciliations].reverse().map(r => `<tr><td>${dmy(r.statementDate)}</td><td class="num">${eur(r.openingBalance)}</td><td class="num">${eur(r.closingBalance)}</td><td class="num">${r.lineIds.length}</td></tr>`).join('')}</tbody></table>` : ''}
  </div>`;
  $('#dfmt').value = localStorage.getItem(KEY + '.dfmt') || 'DMY';
  $('#dfmt').onchange = e => localStorage.setItem(KEY + '.dfmt', e.target.value);
  $('#csv').onchange = async e => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    try {
      const rows = B.parseStatementCsv(decodeText(await file.arrayBuffer()), { dateFormat: $('#dfmt').value });
      commit(() => B.importStatement(books, rows), r => `Imported ${r.added} line(s)${r.skipped ? `, skipped ${r.skipped} already imported` : ''}`);
    } catch (err) { toast(err.message, true); }
  };
  $('#auto').onclick = () => commit(() => B.autoMatch(books), n => `Auto-matched ${n} line(s)`);
  $$('[data-res]').forEach(b => b.onclick = () => resolveDialog(Number(b.dataset.res)));
  $$('[data-del]').forEach(b => b.onclick = () => { if (confirm('Delete this imported line? Only do this if it was imported by mistake.')) commit(() => B.deleteStatementLine(books, Number(b.dataset.del)), 'Line deleted'); });
  $$('[data-un]').forEach(b => b.onclick = () => commit(() => B.unmatchLine(books, Number(b.dataset.un)), 'Unmatched'));
  const preview = () => {
    let p;
    try { p = B.reconciliationPreview(books, { statementDate: $('#rDate').value, closingBalance: B.parseSignedAmount($('#rBal').value) }); }
    catch (e) { $('#rOut').innerHTML = `<p class="status bad">${esc(e.message)}</p>`; return; }
    $('#rOut').innerHTML = `<table style="max-width:520px">
      <tr><td>Opening balance</td><td class="num">${eur(p.opening)}</td></tr>
      <tr><td>+ Cleared items (${p.cleared.length})</td><td class="num">${eur(p.clearedTotal)}</td></tr>
      <tr><td>= Expected closing balance</td><td class="num"><b>${eur(p.opening + p.clearedTotal)}</b></td></tr>
      <tr><td>Statement closing balance</td><td class="num"><b>${eur(p.closingBalance)}</b></td></tr>
      <tr><td>Difference</td><td class="num"><b style="color:${p.difference ? 'var(--bad)' : 'var(--ok)'}">${eur(p.difference)}</b></td></tr></table>
      ${p.unmatched.length ? `<p class="status warn">${p.unmatched.length} statement line(s) up to this date still need resolving.</p>` : ''}
      ${p.outstanding.length ? `<h3>Not yet on the statement (${eur(p.outstandingTotal)})</h3><table>${p.outstanding.map(l => `<tr><td>${dmy(l.date)}</td><td>${esc(l.memo)}</td><td class="num">${eur(l.amount)}</td></tr>`).join('')}</table>
        <p class="small muted">Book balance at this date: ${eur(p.bookBalance)} = statement ${eur(p.closingBalance)} ${p.outstandingTotal >= 0 ? '+' : '−'} outstanding ${eur(Math.abs(p.outstandingTotal))}${p.difference ? ' (after the difference is fixed)' : ''}.</p>` : ''}
      ${p.canFinalize ? '<p class="status ok">✓ Balanced. Ready to finalise.</p><button class="primary" id="rFin">Finalise reconciliation</button>' : ''}`;
    $('#rFin') && ($('#rFin').onclick = () => commit(() => B.finalizeReconciliation(books, { statementDate: p.statementDate, closingBalance: p.closingBalance }), 'Reconciliation finalised ✓'));
  };
  $('#rPrev').onclick = preview;
};
function entryMemo(key) {
  const e = books.ledger.entries.find(x => x.no === Number(key.split(':')[0]));
  return e ? `#${e.no} ${e.memo}` : key;
}
function resolveDialog(id) {
  const s = books.statement.find(x => x.id === id);
  const sugg = B.suggestMatches(books, id);
  const openInv = books.invoices.filter(i => B.invoiceBalance(i) > 0);
  const openBills = books.purchases.filter(p => B.purchaseBalance(p) > 0);
  const inflow = s.amount > 0;
  const exactInv = openInv.filter(i => B.invoiceBalance(i) === s.amount);
  openDialog(`<h2>${inflow ? 'Money in' : 'Money out'}: ${eur(Math.abs(s.amount))}</h2>
    <p class="muted">${dmy(s.date)} · ${esc(s.description)}</p>
    ${sugg.length ? `<div class="option"><h4>Already recorded? Match it</h4>${sugg.map(l => `<button type="button" class="sm" data-m="${l.key}">✓ ${dmy(l.date)} · ${esc(l.memo)} · ${eur(l.amount)}</button> `).join('')}</div>` : ''}
    ${inflow && openInv.length ? `<div class="option"><h4>Customer paid an invoice</h4><div class="row" style="margin:0"><select id="rInv" class="grow">${openInv.map(i => `<option value="${i.id}" ${exactInv[0] === i ? 'selected' : ''}>${esc(i.number)} · ${esc(custName(i.customerId))} · owes ${eur(B.invoiceBalance(i))}</option>`).join('')}</select><button type="button" class="primary" id="rInvGo">Apply</button></div></div>` : ''}
    ${!inflow && openBills.length ? `<div class="option"><h4>Paid a bill</h4><div class="row" style="margin:0"><select id="rBill" class="grow">${openBills.map(p => `<option value="${p.id}">${esc(p.number)} · ${esc(vendName(p.vendorId))} · ${eur(B.purchaseBalance(p))}</option>`).join('')}</select><button type="button" class="primary" id="rBillGo">Apply</button></div></div>` : ''}
    ${!inflow ? `<div class="option"><h4>New purchase with supplier details</h4><button type="button" id="rPurch">Record as purchase…</button></div>` : ''}
    <div class="option"><h4>Categorise</h4><div class="row" style="margin:0">
      <select id="rAcc" class="grow">${acctOptions(a => a.code !== '1000', inflow ? '4100' : '5540')}</select>
      <input id="rMemo" class="grow" placeholder="Memo (optional)" value="${esc(s.description)}"><button type="button" class="primary" id="rCat">Save</button></div>
      <p class="small muted">Common choices: <b>3100 Drawings</b> (money you took for yourself), <b>3000 Capital Introduced</b> (your own money paid in), <b>5540 Bank Charges</b>.</p></div>
    <div class="dlg-actions"><button value="cancel" formnovalidate>Close</button></div>`, () => {}, () => {
    $$('[data-m]').forEach(b => b.onclick = () => { if (commit(() => B.matchLine(books, id, b.dataset.m), 'Matched')) dlg.close(); });
    $('#rInvGo') && ($('#rInvGo').onclick = () => { if (commit(() => B.applyLineToInvoice(books, id, Number($('#rInv').value)), 'Payment applied and matched')) dlg.close(); });
    $('#rBillGo') && ($('#rBillGo').onclick = () => { if (commit(() => B.applyLineToBill(books, id, Number($('#rBill').value)), 'Bill paid and matched')) dlg.close(); });
    $('#rCat').onclick = () => { if (commit(() => B.categorizeLine(books, id, { account: $('#rAcc').value, memo: $('#rMemo').value }), 'Categorised and matched')) dlg.close(); };
    $('#rPurch') && ($('#rPurch').onclick = () => {
      dlg.close();
      purchaseDialog({ vendor: s.description, date: s.date, amount: -s.amount });
      const f = $('#dlgForm'), orig = f.onsubmit;
      f.onsubmit = e => {
        if (e.submitter?.value === 'cancel') return;
        e.preventDefault();
        const ok = commit(() => {
          const p = B.recordPurchase(books, { vendor: f.v.value, date: f.d.value, account: f.acc.value, amount: amt(f.a.value), description: f.desc.value, reference: f.ref.value, paid: true });
          const key = B.bankLines(books).find(l => l.entryNo === p.journalNo).key;
          B.matchLine(books, id, key);
        }, 'Purchase recorded and matched');
        if (ok) dlg.close();
      };
      void orig;
    });
  });
}

// ======================= REPORTS =======================
views.reports = () => {
  const r = views.reports.state ||= { kind: 'pl', from: today().slice(0, 4) + '-01-01', to: today() };
  $('#main').innerHTML = `<div class="card"><div class="head"><h2>Reports</h2><div class="row" style="margin:0">
    <select id="rk"><option value="pl">Profit &amp; loss</option><option value="bs">Balance sheet</option><option value="tb">Trial balance</option><option value="gl">Account ledger</option></select>
    <label id="fromL">From <input type="date" id="rf" value="${r.from}"></label><label>${r.kind === 'pl' || r.kind === 'gl' ? 'To' : 'As at'} <input type="date" id="rt" value="${r.to}"></label>
    ${r.kind === 'gl' ? `<select id="racc">${acctOptions(() => true, r.acc || '1000')}</select>` : ''}
    <button id="rcsv">CSV</button><button id="rprint">Print</button></div></div><div id="rep"></div></div>`;
  $('#rk').value = r.kind; $('#fromL').hidden = !(r.kind === 'pl' || r.kind === 'gl');
  const upd = () => { r.kind = $('#rk').value; r.from = $('#rf').value; r.to = $('#rt').value; r.acc = $('#racc')?.value; render(); };
  ['#rk', '#rf', '#rt', '#racc'].forEach(s => $(s) && ($(s).onchange = upd));
  let html = '', csv = [];
  try {
    const title = (t, sub) => `<h3 style="margin-top:0">${esc(books.settings.businessName)}: ${t}</h3><p class="muted small">${sub}</p>`;
    if (r.kind === 'pl') {
      const p = B.profitAndLoss(books, { from: r.from, to: r.to });
      const sec = (name, rows, tot) => `<tr class="sub"><td colspan="2">${name}</td></tr>${rows.map(x => `<tr><td>${x.code} ${esc(x.name)}</td><td class="num">${eur(x.amount)}</td></tr>`).join('')}<tr><td><b>Total ${name.toLowerCase()}</b></td><td class="num"><b>${eur(tot)}</b></td></tr>`;
      html = title('Profit & loss', `${dmy(r.from)} – ${dmy(r.to)}`) + `<table>${sec('Income', p.income, p.totalIncome)}${sec('Expenses', p.expenses, p.totalExpenses)}<tfoot><tr><td>Net ${p.netProfit >= 0 ? 'profit' : 'loss'}</td><td class="num">${eur(p.netProfit)}</td></tr></tfoot></table>`;
      csv = [['Section', 'Code', 'Account', 'Amount'], ...p.income.map(x => ['Income', x.code, x.name, centsStr(x.amount)]), ...p.expenses.map(x => ['Expense', x.code, x.name, centsStr(x.amount)]), ['', '', 'Net profit', centsStr(p.netProfit)]];
    } else if (r.kind === 'bs') {
      const b = B.balanceSheet(books, r.to);
      const sec = (name, rows, tot) => `<tr class="sub"><td colspan="2">${name}</td></tr>${rows.map(x => `<tr><td>${x.code} ${esc(x.name)}</td><td class="num">${eur(x.amount)}</td></tr>`).join('')}<tr><td><b>Total ${name.toLowerCase()}</b></td><td class="num"><b>${eur(tot)}</b></td></tr>`;
      html = title('Balance sheet', `As at ${dmy(r.to)}`) + `<table>${sec('Assets', b.assets, b.totalAssets)}${sec('Liabilities', b.liabilities, b.totalLiabilities)}<tr><td><b>Net assets</b></td><td class="num"><b>${eur(b.totalAssets - b.totalLiabilities)}</b></td></tr>${sec('Capital account', b.equity, b.totalEquity)}</table>
        <p class="status ${b.balanced ? 'ok' : 'bad'}">${b.balanced ? '✓ Net assets equal the capital account' : '✗ Does not balance'}</p>`;
      csv = [['Section', 'Code', 'Account', 'Amount'], ...b.assets.map(x => ['Asset', x.code, x.name, centsStr(x.amount)]), ...b.liabilities.map(x => ['Liability', x.code, x.name, centsStr(x.amount)]), ...b.equity.map(x => ['Capital', x.code, x.name, centsStr(x.amount)])];
    } else if (r.kind === 'tb') {
      const tb = B.trialBalance(books.ledger, r.to);
      const rows = tb.rows.filter(x => x.debit || x.credit);
      html = title('Trial balance', `As at ${dmy(r.to)}`) + `<table><thead><tr><th>Code</th><th>Account</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead><tbody>
        ${rows.map(x => `<tr><td>${x.code}</td><td>${esc(x.name)}</td><td class="num">${eurBlank(x.debit)}</td><td class="num">${eurBlank(x.credit)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td></td><td>Totals</td><td class="num">${eur(tb.totalDebit)}</td><td class="num">${eur(tb.totalCredit)}</td></tr></tfoot></table>
        <p class="status ${tb.balanced ? 'ok' : 'bad'}">${tb.balanced ? '✓ Debits equal credits' : '✗ Out of balance'}</p>`;
      csv = [['Code', 'Account', 'Debit', 'Credit'], ...rows.map(x => [x.code, x.name, centsStr(x.debit), centsStr(x.credit)]), ['', 'Totals', centsStr(tb.totalDebit), centsStr(tb.totalCredit)]];
    } else {
      const code = r.acc || '1000'; let run = 0; const rows = [];
      for (const e of books.ledger.entries) {
        if (e.date > r.to) continue;
        for (const l of e.lines) if (l.account === code) { run += l.debit - l.credit; if (e.date >= r.from) rows.push({ e, l, run }); }
      }
      rows.sort((a, b) => a.e.date.localeCompare(b.e.date) || a.e.no - b.e.no);
      const opening = rows.length ? rows[0].run - (rows[0].l.debit - rows[0].l.credit) : run;
      let bal = opening;
      html = title(`${code} ${acctName(code)}`, `${dmy(r.from)} – ${dmy(r.to)}`) + `<table><thead><tr><th>Date</th><th>#</th><th>Memo</th><th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th></tr></thead><tbody>
        <tr class="sub"><td colspan="5">Opening balance</td><td class="num">${eur(opening)}</td></tr>
        ${rows.map(x => { bal += x.l.debit - x.l.credit; return `<tr><td>${dmy(x.e.date)}</td><td>${x.e.no}</td><td>${esc(x.e.memo)}</td><td class="num">${eurBlank(x.l.debit)}</td><td class="num">${eurBlank(x.l.credit)}</td><td class="num">${eur(bal)}</td></tr>`; }).join('')}</tbody></table>`;
      bal = opening;
      csv = [['Date', 'Entry', 'Memo', 'Debit', 'Credit', 'Balance'], ...rows.map(x => { bal += x.l.debit - x.l.credit; return [x.e.date, x.e.no, x.e.memo, centsStr(x.l.debit), centsStr(x.l.credit), centsStr(bal)]; })];
    }
  } catch (e) { html = `<p class="status bad">${esc(e.message)}</p>`; }
  $('#rep').innerHTML = html;
  $('#rprint').onclick = () => printHtml(`<div class="inv-doc">${html}</div>`);
  $('#rcsv').onclick = () => download(`${r.kind}-${r.to}.csv`, toCsv(csv), 'text/csv');
};

// ======================= YEAR END & FORM 11 =======================
views.yearend = () => {
  const y = views.yearend.state ||= { from: `${Number(today().slice(0, 4)) - 1}-01-01`, to: `${Number(today().slice(0, 4)) - 1}-12-31` };
  let f, chk, ca;
  try { f = B.form11Extracts(books, y); chk = B.yearEndChecklist(books, y); ca = B.capitalAllowances(books, { to: y.to }); }
  catch (e) { $('#main').innerHTML = `<div class="card"><p class="status bad">${esc(e.message)}</p></div>`; return; }
  const euro = c => '€' + (c < 0 ? '-' : '') + Math.abs(c >= 0 ? B.roundDiv(c, 100) : -B.roundDiv(-c, 100)).toLocaleString('en-IE');
  const taxYear = y.to.slice(0, 4);
  $('#main').innerHTML = `
  <div class="card"><div class="head"><h2>Year end ${taxYear}</h2><div class="row" style="margin:0">
    <label>Accounts from <input type="date" id="yf" value="${y.from}"></label><label>to <input type="date" id="yt" value="${y.to}"></label></div></div>
    <ul class="check-list">${chk.items.map(i => `<li><span class="ic">${i.info ? 'ℹ️' : i.ok ? '✅' : '⚠️'}</span><div><b>${esc(i.label)}</b>${i.detail ? `<div class="small muted">${esc(i.detail)}</div>` : ''}</div></li>`).join('')}</ul>
    ${chk.debtors.length ? `<h3>Debtors at ${dmy(y.to)}</h3><table>${chk.debtors.map(x => `<tr><td>${esc(x.inv.number)}</td><td>${esc(custName(x.inv.customerId))}</td><td>${dmy(x.inv.date)}</td><td class="num">${eur(x.bal)}</td></tr>`).join('')}</table>` : ''}
    ${chk.creditors.length ? `<h3>Creditors at ${dmy(y.to)}</h3><table>${chk.creditors.map(x => `<tr><td>${esc(x.p.number)}</td><td>${esc(vendName(x.p.vendorId))}</td><td>${dmy(x.p.date)}</td><td class="num">${eur(x.bal)}</td></tr>`).join('')}</table>` : ''}
    <div class="row" style="margin-top:16px">
      <button id="depBtn">Post depreciation…</button>
      ${books.ledger.lockDate >= y.to ? `<button id="unlock" class="ghost danger">Unlock year</button>` : `<button id="lockBtn" class="primary">🔒 Lock ${taxYear} books</button>`}
    </div>
  </div>

  <div class="card"><div class="head"><h2>Form 11 — Extracts From Accounts</h2><div class="row" style="margin:0"><button id="fCsv">CSV</button><button id="fPrint">Print</button></div></div>
    <p class="small muted">Accounts period [124] ${dmy(y.from)} → [125] ${dmy(y.to)}. Line numbers follow the 2025 Form 11 (Revenue can renumber them each year). Amounts are rounded to whole euro for ROS; the exact figures are in the CSV.</p>
    <div id="f11">
    <table><thead><tr><th>Line</th><th>Description</th><th class="num">Amount</th></tr></thead><tbody>
      ${f.rows.map(r => `<tr><td><b>${r.line}</b></td><td>${esc(r.label)}</td><td class="num">${euro(r.cents)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">No activity in this period.</td></tr>'}
    </tbody></table>
    <h3>Suggested adjustments [159 – 168]</h3>
    <table>${Object.entries(f.adjustments).map(([k, a]) => `<tr><td><b>${k}</b></td><td>${esc(a.note)}</td><td class="num">${a.amount ? euro(a.amount) : '—'}</td></tr>`).join('')}</table>
    ${ca.rows.length ? `<h3>Capital allowances (wear &amp; tear 12.5%, estimate)</h3><table><thead><tr><th>Asset</th><th>Bought</th><th class="num">Cost</th><th class="num">Year</th><th class="num">Allowance</th></tr></thead><tbody>
      ${ca.rows.map(r => `<tr><td>${esc(r.description)}</td><td>${dmy(r.date)}</td><td class="num">${eur(r.cost)}</td><td class="num">${r.yearOfClaim} of 8</td><td class="num">${eur(r.allowance)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="4">Total wear &amp; tear (Machinery &amp; Plant)</td><td class="num">${eur(ca.total)}</td></tr></tfoot></table>
      <p class="small muted">The asset must still be in use at the end of the period. Check motor vehicle limits separately.</p>` : ''}
    </div>
    <p class="status ${f.checks.capitalEqualsNetAssets && f.checks.trialBalanced ? 'ok' : 'bad'}">${f.checks.capitalEqualsNetAssets && f.checks.trialBalanced ? '✓ Closing capital [147] equals net assets [156]. Trial balance balances.' : '✗ Integrity check failed. Review the trial balance.'}</p>
    <p class="small muted">These extracts come straight from your ledger. They are not a tax computation: you still need to review the add-backs, the private-use portions, capital allowances and preliminary tax.</p>
  </div>`;
  const upd = () => { y.from = $('#yf').value; y.to = $('#yt').value; render(); };
  $('#yf').onchange = upd; $('#yt').onchange = upd;
  $('#fPrint').onclick = () => printHtml(`<div class="inv-doc"><h2>${esc(books.settings.businessName)}: Form 11 Extracts From Accounts</h2><p>Period ${dmy(y.from)} – ${dmy(y.to)}</p>${$('#f11').innerHTML}</div>`);
  $('#fCsv').onclick = () => download(`form11-extracts-${taxYear}.csv`, toCsv([['Line', 'Description', 'Amount (exact)', 'Amount (whole euro)'],
    ['124', 'Accounts from', y.from, ''], ['125', 'Accounts to', y.to, ''],
    ...f.rows.map(r => [r.line, r.label, centsStr(r.cents), r.euro]),
    ...Object.entries(f.adjustments).map(([k, a]) => [k, 'SUGGESTED: ' + a.note, centsStr(a.amount), B.roundDiv(Math.max(0, a.amount), 100)])]), 'text/csv');
  $('#depBtn').onclick = () => openDialog(`<h2>Post depreciation</h2>
    <p class="small muted">Accounting depreciation on equipment (for example, a laptop over 3 years). It reduces accounting profit and is added back on Form 11 (line 167). Tax relief comes through capital allowances instead.</p>
    <div class="row"><label>Date <input type="date" name="d" value="${y.to}"></label><label>Amount € <input name="a" inputmode="decimal" required></label></div>${dlgButtons('Post')}`,
  fm => !!commit(() => B.postDepreciation(books, { date: fm.d.value, amount: amt(fm.a.value) }), 'Depreciation posted'));
  $('#lockBtn') && ($('#lockBtn').onclick = () => { if (confirm(`Lock all entries up to ${dmy(y.to)}? No one will be able to post or reverse anything dated on or before then. Take a backup first.`)) commit(() => B.lockBooks(books, y.to), 'Books locked'); });
  $('#unlock') && ($('#unlock').onclick = () => { if (confirm('Unlock the books? Only do this to correct an error before filing.')) commit(() => B.lockBooks(books, null), 'Books unlocked'); });
};

// ======================= JOURNAL =======================
views.journal = () => {
  const q = (views.journal.q || '').toLowerCase();
  const reversed = new Set(books.ledger.entries.map(e => e.reverses).filter(Boolean));
  const list = [...books.ledger.entries].reverse().filter(e => !q || e.memo.toLowerCase().includes(q) || e.lines.some(l => l.account.includes(q) || acctName(l.account).toLowerCase().includes(q)));
  $('#main').innerHTML = `<div class="card"><div class="head"><h2>Journal</h2><div class="row" style="margin:0"><input type="search" id="jq" placeholder="Search…" value="${esc(views.journal.q || '')}"><button class="primary" id="jNew">+ Manual entry</button></div></div>
    <p class="small muted">Every invoice, purchase, payment and bank categorisation creates an entry here. Entries can't be edited or deleted. To correct one, reverse it.</p>
    ${list.slice(0, 300).map(e => `<div class="option"><div class="row" style="margin:0 0 6px;justify-content:space-between"><div><b>#${e.no}</b> · ${dmy(e.date)} · ${esc(e.memo || '—')}
      ${e.reverses ? `<span class="badge bad">reverses #${e.reverses}</span>` : ''}${reversed.has(e.no) ? '<span class="badge">reversed</span>' : ''}</div>
      ${!e.reverses && !reversed.has(e.no) && !e.source ? `<button class="sm" data-rev="${e.no}">Reverse</button>` : ''}</div>
      <table>${e.lines.map(l => `<tr><td style="${l.credit ? 'padding-left:32px' : ''}">${l.account} · ${esc(acctName(l.account))}</td><td class="num" style="width:140px">${eurBlank(l.debit)}</td><td class="num" style="width:140px">${eurBlank(l.credit)}</td></tr>`).join('')}</table></div>`).join('') || '<div class="empty">No entries.</div>'}</div>`;
  $('#jq').oninput = e => { views.journal.q = e.target.value; clearTimeout(views.journal.t); views.journal.t = setTimeout(() => { render(); $('#jq').focus(); $('#jq').setSelectionRange(99, 99); }, 250); };
  $('#jNew').onclick = manualEntryDialog;
  $$('[data-rev]').forEach(b => b.onclick = () => { if (confirm(`Post a reversing entry for #${b.dataset.rev}, dated today?`)) commit(() => reverseEntry(books.ledger, Number(b.dataset.rev), { date: today() }), r => `Entry #${r.no} posted`); });
};
function manualEntryDialog() {
  openDialog(`<h2>Manual journal entry</h2><p class="small muted">For adjustments like prepayments, accruals or corrections. Everyday transactions are easier from Invoices, Purchases and Bank.</p>
    <div class="row"><label>Date <input type="date" name="d" value="${today()}" required></label><label class="grow">Description <input name="m" required></label></div>
    <table class="lines"><thead><tr><th>Account</th><th class="num">Debit</th><th class="num">Credit</th><th></th></tr></thead><tbody id="jl"></tbody></table>
    <div class="row" style="justify-content:space-between;margin-top:8px"><button type="button" class="sm" id="jAdd">+ Line</button><span id="jSt" class="status idle"></span></div>${dlgButtons('Post entry')}`,
  f => !!commit(() => postEntry(books.ledger, readJ(f)), e => `Entry #${e.no} posted`),
  f => {
    const add = () => { const tr = document.createElement('tr'); tr.innerHTML = `<td><select class="a"><option value="">Account…</option>${acctOptions()}</select></td><td class="num"><input class="dr" inputmode="decimal"></td><td class="num"><input class="cr" inputmode="decimal"></td><td><button type="button" class="icon">×</button></td>`;
      tr.querySelector('.icon').onclick = () => { if ($$('#jl tr').length > 2) { tr.remove(); st(); } };
      tr.querySelector('.dr').oninput = e => { if (e.target.value) tr.querySelector('.cr').value = ''; };
      tr.querySelector('.cr').oninput = e => { if (e.target.value) tr.querySelector('.dr').value = ''; };
      $('#jl').appendChild(tr); };
    const st = () => {
      const s = $('#jSt'), btn = f.querySelector('.primary');
      try { const d = readJ(f); const dr = d.lines.reduce((a, l) => a + l.debit, 0), cr = d.lines.reduce((a, l) => a + l.credit, 0);
        if (dr !== cr) { s.className = 'status bad'; s.textContent = `Out of balance by ${eur(Math.abs(dr - cr))}`; btn.disabled = true; return; }
        validateEntry(books.ledger, d); s.className = 'status ok'; s.textContent = `✓ Balanced: ${eur(dr)}`; btn.disabled = false;
      } catch (e) { s.className = 'status bad'; s.textContent = e.message; btn.disabled = true; }
    };
    add(); add(); f.oninput = st; f.onchange = st; $('#jAdd').onclick = () => { add(); st(); }; st();
  });
}
function readJ(f) {
  return { date: f.d.value, memo: f.m.value, lines: $$('#jl tr', f).map((tr, i) => {
    const g = c => { try { return amt(tr.querySelector(c).value); } catch (e) { throw new Error(`Line ${i + 1}: ${e.message}`); } };
    return { account: tr.querySelector('.a').value, debit: g('.dr'), credit: g('.cr') };
  }) };
}

// ======================= SETTINGS =======================
views.settings = () => {
  const s = books.settings;
  $('#main').innerHTML = `
  <div class="card"><h2>Business details</h2><form id="bizF">
    <div class="row"><label class="grow">Business name <input name="businessName" value="${esc(s.businessName)}" required></label><label>Currency <input value="EUR (€)" disabled size="8"></label></div>
    <div class="row"><label class="grow">Address (shown on invoices) <textarea name="address">${esc(s.address)}</textarea></label>
      <div class="grow"><label>Email <input name="email" type="email" value="${esc(s.email)}"></label><br><label>Phone <input name="phone" value="${esc(s.phone)}"></label></div></div>
    <div class="row"><label class="grow">Website <input name="website" value="${esc(s.website)}"></label><label class="grow">IBAN <input name="iban" value="${esc(s.iban)}"></label><label>BIC <input name="bic" value="${esc(s.bic)}"></label></div>
    <div class="row"><label>Payment terms (days) <input name="paymentTermsDays" type="number" min="0" max="365" value="${s.paymentTermsDays}"></label><label>Invoice prefix <input name="invoicePrefix" value="${esc(s.invoicePrefix)}" size="8"></label>
      <label class="grow">Default invoice notes <input name="invoiceNotes" value="${esc(s.invoiceNotes)}" placeholder="Thank you for your business."></label></div>
    <div class="row"><label>Logo <input type="file" id="logoF" accept="image/*"></label>${s.logoDataUrl ? `<img src="${s.logoDataUrl}" style="max-height:48px"><button type="button" class="sm ghost danger" id="logoX">Remove logo</button>` : '<span class="small muted">PNG or JPG, under 300 KB</span>'}</div>
    <p class="small muted">VAT status: <b>Not VAT registered</b>, so invoices never include VAT. The Dashboard tracks your turnover against the ${eur(s.vatThreshold)} threshold.</p>
    <button class="primary">Save details</button></form></div>

  <div class="card"><h2>Opening bank balance</h2>${books.bankOpening ? `<p>${eur(books.bankOpening.amount)} on ${dmy(books.bankOpening.date)}</p>` :
    `<p class="small muted">The balance on your business account the day before you start recording here. It is the starting point for reconciliation.</p>
    <div class="row"><label>Date <input type="date" id="obD" value="${today().slice(0, 4)}-01-01"></label><label>Balance € <input id="obA" inputmode="decimal"></label><button class="primary" id="obGo">Set</button></div>`}</div>

  <div class="card"><h2>Chart of accounts</h2>
    <form id="accF" class="row"><label>Code <input name="code" required size="6"></label><label class="grow">Name <input name="name" required></label>
      <label>Type <select name="type">${ACCOUNT_TYPES.map(t => `<option>${t}</option>`).join('')}</select></label>
      <label>Form 11 line <select name="f11"><option value="">—</option>${Object.entries(B.F11_LINES).map(([k, v]) => `<option value="${k}">${k} ${esc(v)}</option>`).join('')}</select></label><button class="primary">Add</button></form>
    <table><thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Form 11</th></tr></thead><tbody>${books.ledger.accounts.map(a => `<tr><td>${a.code}</td><td>${esc(a.name)}</td><td>${a.type}</td><td class="small muted">${a.f11 ? a.f11 + ' ' + esc(B.F11_LINES[a.f11]) : ''}</td></tr>`).join('')}</tbody></table></div>`;
  $('#bizF').onsubmit = e => {
    e.preventDefault(); const f = e.target;
    commit(() => {
      for (const k of ['businessName', 'address', 'email', 'phone', 'website', 'iban', 'bic', 'invoicePrefix', 'invoiceNotes']) books.settings[k] = f[k].value.trim();
      const days = Number(f.paymentTermsDays.value);
      if (!Number.isInteger(days) || days < 0 || days > 365) throw new Error('Payment terms must be 0–365 days');
      if (!books.settings.businessName) throw new Error('Business name is required');
      books.settings.paymentTermsDays = days; books.ledger.name = books.settings.businessName;
    }, 'Saved');
  };
  $('#logoF').onchange = e => {
    const file = e.target.files[0]; if (!file) return;
    if (file.size > 300 * 1024) return toast('Logo must be under 300 KB', true);
    const r = new FileReader(); r.onload = () => commit(() => { books.settings.logoDataUrl = r.result; }, 'Logo saved'); r.readAsDataURL(file);
  };
  $('#logoX') && ($('#logoX').onclick = () => commit(() => { books.settings.logoDataUrl = ''; }, 'Logo removed'));
  $('#obGo') && ($('#obGo').onclick = () => commit(() => B.setOpeningBalance(books, { date: $('#obD').value, amount: amt($('#obA').value) }), 'Opening balance set'));
  $('#accF').onsubmit = e => { e.preventDefault(); const f = e.target; commit(() => B.addBookAccount(books, { code: f.code.value, name: f.name.value, type: f.type.value, f11: f.f11.value || null }), 'Account added'); };
};

// ---------- backup / restore ----------
$('#exportBtn').onclick = () => {
  download(`clearbooks-backup-${today()}.json`, JSON.stringify(B.serialize(books), null, 1), 'application/json');
  localStorage.setItem(KEY + '.lastBackup', today()); render();
};
$('#importFile').onchange = async e => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  try {
    const nb = B.loadBooks(JSON.parse(await file.text()));
    if (!confirm(`Restore backup with ${nb.ledger.entries.length} journal entries and ${nb.invoices.length} invoices? This replaces the data in this browser.`)) return;
    books = nb; save(); render(); toast('Backup restored');
  } catch (err) { toast('Restore failed: ' + err.message, true); }
};

load();
render();

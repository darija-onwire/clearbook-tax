// Business layer for ClearBooks Tax & Payroll's own books (Irish sole trader, EUR,
// not VAT registered): invoices, purchases, bank import & reconciliation, reports and
// Form 11 "Extracts From Accounts". Every money movement is posted through the
// double-entry engine in ledger.js; documents only link to journal entries.
import {
  createLedger, addAccount, postEntry, reverseEntry, trialBalance, parseAmount, formatCents,
  loadLedger, setLockDate, isValidDate, LedgerError,
} from './ledger.js';

export { LedgerError, trialBalance };

/** System accounts the app posts to automatically. */
export const SYS = {
  BANK: '1000', AR: '1100', FIXED: '1500', ACC_DEP: '1510', AP: '2000', TAX: '2100',
  CAPITAL: '3000', DRAWINGS: '3100', REVENUE: '4000', DEPRECIATION: '5700', BAD_DEBTS: '5800',
};

/** Form 11 (2025) Extracts From Accounts line labels used for mapping accounts. */
export const F11_LINES = {
  128: 'Sales / Receipts / Turnover', 129: 'Receipts from Government Agencies', 130: 'Other Trading Income',
  131: 'Purchases', 133: 'Salaries / Wages', 134: 'Additional Staff Costs', 135: 'Sub-Contractors (RCT)',
  136: 'Other Sub-Contractors', 137: 'Consultancy, Professional fees', 138: 'Motor, Travel and Subsistence',
  139: 'Repairs / Renewals', 140: 'Rental Expenses', 141: 'Depreciation, Goodwill / Capital write-off',
  142: 'Provisions including bad debts', 143: 'Other Expenses',
  145: 'Cash / Capital introduced', 146: 'Drawings', 149: 'Debtors and Prepayments', 150: 'Cash / Bank (Debit)',
  151: 'Bank / Loans / Overdraft (Credit)', 154: 'Creditors and Accruals', 155: 'Tax Creditors',
  FA: 'Fixed assets (net) — part of Net Assets [156]',
};

/** Chart of accounts for an Irish sole-trader practice, each mapped to a Form 11 line. */
export const IRISH_CHART = [
  { code: '1000', name: 'Business Current Account', type: 'asset', f11: '150' },
  { code: '1100', name: 'Debtors (Trade Receivables)', type: 'asset', f11: '149' },
  { code: '1200', name: 'Prepayments', type: 'asset', f11: '149' },
  { code: '1500', name: 'Computer & Office Equipment (cost)', type: 'asset', f11: 'FA' },
  { code: '1510', name: 'Equipment — Accumulated Depreciation', type: 'asset', f11: 'FA' },
  { code: '2000', name: 'Creditors (Trade Payables)', type: 'liability', f11: '154' },
  { code: '2050', name: 'Accruals', type: 'liability', f11: '154' },
  { code: '2100', name: 'Tax Creditors', type: 'liability', f11: '155' },
  { code: '2200', name: 'Business Credit Card', type: 'liability', f11: '151' },
  { code: '3000', name: 'Capital Introduced', type: 'equity', f11: '145' },
  { code: '3100', name: 'Drawings', type: 'equity', f11: '146' },
  { code: '3200', name: 'Capital Account b/f', type: 'equity', f11: null },
  { code: '4000', name: 'Fee Income — Tax & Payroll Services', type: 'revenue', f11: '128' },
  { code: '4100', name: 'Other Income', type: 'revenue', f11: '130' },
  { code: '5000', name: 'Sub-Contractors', type: 'expense', f11: '136' },
  { code: '5100', name: 'Professional Fees (legal, accountancy)', type: 'expense', f11: '137' },
  { code: '5150', name: 'Professional Subscriptions (CTA, ITI, CPA…)', type: 'expense', f11: '143' },
  { code: '5160', name: 'Professional Indemnity & Business Insurance', type: 'expense', f11: '143' },
  { code: '5200', name: 'Motor Expenses', type: 'expense', f11: '138' },
  { code: '5210', name: 'Travel & Subsistence', type: 'expense', f11: '138' },
  { code: '5300', name: 'Rent', type: 'expense', f11: '140' },
  { code: '5400', name: 'Light & Heat', type: 'expense', f11: '143' },
  { code: '5410', name: 'Telephone & Internet', type: 'expense', f11: '143' },
  { code: '5500', name: 'Software & Subscriptions', type: 'expense', f11: '143' },
  { code: '5510', name: 'Office, Postage & Stationery', type: 'expense', f11: '143' },
  { code: '5520', name: 'Training & CPD', type: 'expense', f11: '143' },
  { code: '5530', name: 'Advertising & Marketing', type: 'expense', f11: '143' },
  { code: '5540', name: 'Bank Charges', type: 'expense', f11: '143' },
  { code: '5600', name: 'Repairs & Renewals', type: 'expense', f11: '139' },
  { code: '5700', name: 'Depreciation', type: 'expense', f11: '141' },
  { code: '5800', name: 'Bad Debts', type: 'expense', f11: '142' },
  { code: '5900', name: 'Entertainment (disallowable)', type: 'expense', f11: '143' },
  { code: '5910', name: 'Donations', type: 'expense', f11: '143' },
];

// ---------- helpers ----------
/** Round n/d half-up for non-negative safe integers (pure integer arithmetic). */
export function roundDiv(n, d) {
  if (!Number.isSafeInteger(n) || n < 0 || !Number.isSafeInteger(d) || d <= 0) throw new LedgerError('roundDiv: bad operands');
  if (!Number.isSafeInteger(2 * n + d)) throw new LedgerError('Amount too large');
  return Math.floor((2 * n + d) / (2 * d));
}
export const addDays = (date, n) => {
  const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
};
const dayDiff = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);
const need = (cond, msg) => { if (!cond) throw new LedgerError(msg); };
const pad = n => String(n).padStart(4, '0');
const sum = (arr, f = x => x) => arr.reduce((s, x) => s + f(x), 0);
const money = (b, c) => formatCents(c, b.settings.currency);
const dmy = d => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '');

// ---------- books ----------
export function createBooks({ businessName = 'ClearBooks Tax & Payroll' } = {}) {
  const currency = 'EUR';
  const ledger = createLedger({ name: businessName, currency });
  IRISH_CHART.forEach(a => addAccount(ledger, a));
  return {
    version: 3,
    settings: {
      businessName, currency, address: '', email: '', phone: '', website: '', iban: '', bic: '', logoDataUrl: '',
      vatRegistered: false, vatNumber: '', vatThreshold: 4250000, // €42,500 services threshold (calendar-year test)
      paymentTermsDays: 30, invoicePrefix: 'INV-', invoiceNotes: '',
    },
    ledger,
    customers: [], vendors: [], invoices: [], purchases: [], statement: [], reconciliations: [],
    bankOpening: null,
    seq: { customer: 1, vendor: 1, invoice: 1, purchase: 1, stmt: 1, rec: 1 },
  };
}
const nextId = (b, k) => b.seq[k]++;
const account = (b, code) => b.ledger.accounts.find(a => a.code === code);

export function addBookAccount(b, { code, name, type, f11 }) {
  need(!f11 || F11_LINES[f11], 'Unknown Form 11 line');
  return addAccount(b.ledger, { code, name, type, f11 });
}

export function addCustomer(b, { name, email = '', address = '' }) {
  name = String(name ?? '').trim(); need(name, 'Customer name is required');
  need(!b.customers.some(c => c.name.toLowerCase() === name.toLowerCase()), `Customer "${name}" already exists`);
  const c = { id: nextId(b, 'customer'), name, email: String(email).trim(), address: String(address).trim() };
  b.customers.push(c); return c;
}
export function updateCustomer(b, id, { name, email, address }) {
  const c = b.customers.find(x => x.id === id); need(c, 'Customer not found');
  if (name !== undefined) { name = String(name).trim(); need(name, 'Customer name is required'); c.name = name; }
  if (email !== undefined) c.email = String(email).trim();
  if (address !== undefined) c.address = String(address).trim();
  return c;
}
export function addVendor(b, { name }) {
  name = String(name ?? '').trim(); need(name, 'Supplier name is required');
  const existing = b.vendors.find(v => v.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  const v = { id: nextId(b, 'vendor'), name }; b.vendors.push(v); return v;
}

/** Opening bank balance: Dr Bank / Cr Capital Account b/f. Starting point for reconciliation. */
export function setOpeningBalance(b, { date, amount }) {
  need(!b.bankOpening, 'Opening balance already set (reverse it in the journal if wrong)');
  need(isValidDate(date), 'Opening date must be a valid date');
  need(Number.isSafeInteger(amount) && amount >= 0, 'Opening balance must be zero or more');
  const e = amount > 0 ? postEntry(b.ledger, {
    date, memo: 'Opening bank balance',
    lines: [{ account: SYS.BANK, debit: amount }, { account: '3200', credit: amount }],
    source: { type: 'opening' },
  }) : null;
  b.bankOpening = { date, amount, entryNo: e?.no ?? null };
  return b.bankOpening;
}

// ---------- invoices ----------
/** Compute invoice totals from typed qty/price. Returns integer cents. */
export function computeInvoice(items, taxBp = 0) {
  need(Array.isArray(items) && items.length, 'Invoice needs at least one item');
  need(Number.isSafeInteger(taxBp) && taxBp >= 0 && taxBp <= 10000, 'Tax rate must be between 0% and 100%');
  const lines = items.map((it, i) => {
    const description = String(it.description ?? '').trim();
    need(description, `Item ${i + 1}: description is required`);
    const qtyH = parseAmount(String(it.qty ?? '')); // hundredths of a unit
    const unitPrice = typeof it.unitPrice === 'number' ? it.unitPrice : parseAmount(String(it.unitPrice ?? ''));
    need(qtyH > 0, `Item ${i + 1}: quantity must be greater than zero`);
    need(Number.isSafeInteger(unitPrice) && unitPrice >= 0, `Item ${i + 1}: invalid price`);
    return { description, qty: qtyH / 100, qtyH, unitPrice, amount: roundDiv(qtyH * unitPrice, 100) };
  });
  const subtotal = sum(lines, l => l.amount);
  const tax = roundDiv(subtotal * taxBp, 10000);
  need(subtotal + tax > 0, 'Invoice total must be greater than zero');
  return { items: lines, subtotal, taxBp, tax, total: subtotal + tax };
}

export function createInvoice(b, { customerId, date, dueDate, items, taxBp = 0, notes = '', revenueAccount = SYS.REVENUE }) {
  const cust = b.customers.find(c => c.id === customerId);
  need(cust, 'Choose a customer');
  need(isValidDate(date), 'Invoice date is invalid');
  // Not VAT registered → never charge VAT. Guard in the engine, not just the UI.
  need(b.settings.vatRegistered || taxBp === 0, 'You are not VAT registered, so invoices cannot include VAT');
  dueDate = dueDate || addDays(date, b.settings.paymentTermsDays);
  need(isValidDate(dueDate) && dueDate >= date, 'Due date must be on or after the invoice date');
  need(account(b, revenueAccount)?.type === 'revenue', 'Income account must be a revenue account');
  const calc = computeInvoice(items, taxBp);
  const number = b.settings.invoicePrefix + pad(b.seq.invoice);
  const lines = [{ account: SYS.AR, debit: calc.total }, { account: revenueAccount, credit: calc.subtotal }];
  if (calc.tax) lines.push({ account: SYS.TAX, credit: calc.tax });
  const id = b.seq.invoice;
  const e = postEntry(b.ledger, { date, memo: `Invoice ${number} — ${cust.name}`, lines, source: { type: 'invoice', id } });
  b.seq.invoice++;
  const inv = {
    id, number, customerId, customerSnapshot: { name: cust.name, address: cust.address, email: cust.email },
    date, dueDate, ...calc, notes: String(notes), journalNo: e.no, payments: [], writeOff: null, voidJournalNo: null, voidDate: null,
  };
  b.invoices.push(inv);
  return inv;
}

export const invoicePaid = inv => sum(inv.payments, p => p.amount);
export const invoiceBalance = inv => (inv.voidJournalNo ? 0 : inv.total - invoicePaid(inv) - (inv.writeOff?.amount ?? 0));
/** Amount owed on an invoice as at a date (for year-end debtors). */
export function invoiceBalanceAt(inv, date) {
  if (inv.date > date) return 0;
  if (inv.voidJournalNo && inv.voidDate <= date) return 0;
  return inv.total - sum(inv.payments.filter(p => p.date <= date), p => p.amount) - (inv.writeOff && inv.writeOff.date <= date ? inv.writeOff.amount : 0);
}
export function invoiceStatus(inv, today) {
  if (inv.voidJournalNo) return 'void';
  const bal = invoiceBalance(inv);
  if (bal === 0) return inv.writeOff ? 'written off' : 'paid';
  if (today && inv.dueDate < today) return 'overdue';
  return bal < inv.total ? 'part paid' : 'open';
}

/** Customer payment into the bank: Dr Bank / Cr Debtors. */
export function recordInvoicePayment(b, invoiceId, { date, amount }) {
  const inv = b.invoices.find(i => i.id === invoiceId); need(inv, 'Invoice not found');
  need(!inv.voidJournalNo, 'Invoice is void');
  need(Number.isSafeInteger(amount) && amount > 0, 'Payment amount must be greater than zero');
  need(amount <= invoiceBalance(inv), `Payment exceeds balance due (${money(b, invoiceBalance(inv))})`);
  need(isValidDate(date) && date >= inv.date, 'Payment date must be on or after the invoice date');
  const e = postEntry(b.ledger, {
    date, memo: `Payment received — ${inv.number}`,
    lines: [{ account: SYS.BANK, debit: amount }, { account: SYS.AR, credit: amount }],
    source: { type: 'invoice-payment', id: inv.id },
  });
  const p = { date, amount, journalNo: e.no };
  inv.payments.push(p);
  return p;
}
/** Write off the unpaid balance as a bad debt: Dr Bad Debts / Cr Debtors. */
export function writeOffInvoice(b, invoiceId, { date }) {
  const inv = b.invoices.find(i => i.id === invoiceId); need(inv, 'Invoice not found');
  need(!inv.voidJournalNo && !inv.writeOff, 'Invoice cannot be written off');
  const amount = invoiceBalance(inv); need(amount > 0, 'Nothing left to write off');
  need(isValidDate(date) && date >= inv.date, 'Write-off date must be on or after the invoice date');
  const e = postEntry(b.ledger, {
    date, memo: `Bad debt written off — ${inv.number}`,
    lines: [{ account: SYS.BAD_DEBTS, debit: amount }, { account: SYS.AR, credit: amount }],
    source: { type: 'invoice-writeoff', id: inv.id },
  });
  inv.writeOff = { date, amount, journalNo: e.no };
  return inv.writeOff;
}
export function voidInvoice(b, invoiceId, { date }) {
  const inv = b.invoices.find(i => i.id === invoiceId); need(inv, 'Invoice not found');
  need(!inv.voidJournalNo, 'Invoice is already void');
  need(inv.payments.length === 0 && !inv.writeOff, 'Invoice has payments or a write-off; it cannot be voided');
  const d = date < inv.date ? inv.date : date;
  inv.voidJournalNo = reverseEntry(b.ledger, inv.journalNo, { date: d }).no;
  inv.voidDate = d;
  return inv;
}

// ---------- purchases / bills ----------
/** paid=true → paid from the bank now (Dr Expense / Cr Bank); false → bill to pay later (Cr Creditors). */
export function recordPurchase(b, { vendor, date, dueDate, account: acct, amount, description = '', reference = '', paid = true }) {
  const v = addVendor(b, { name: vendor });
  need(isValidDate(date), 'Purchase date is invalid');
  const a = account(b, acct);
  need(a && (a.type === 'expense' || (a.type === 'asset' && ![SYS.BANK, SYS.AR, SYS.ACC_DEP].includes(a.code))), 'Choose an expense or fixed-asset account');
  need(Number.isSafeInteger(amount) && amount > 0, 'Amount must be greater than zero');
  if (!paid) { dueDate = dueDate || date; need(isValidDate(dueDate) && dueDate >= date, 'Due date must be on or after the purchase date'); }
  const id = b.seq.purchase;
  const e = postEntry(b.ledger, {
    date, memo: `${v.name}${description ? ' — ' + description : ''}`,
    lines: [{ account: acct, debit: amount }, { account: paid ? SYS.BANK : SYS.AP, credit: amount }],
    source: { type: 'purchase', id },
  });
  b.seq.purchase++;
  const p = {
    id, number: 'P-' + pad(id), vendorId: v.id, date, dueDate: paid ? date : dueDate, account: acct, amount,
    description: String(description).trim(), reference: String(reference).trim(), paidImmediately: !!paid,
    journalNo: e.no, payments: [], voidJournalNo: null, voidDate: null,
  };
  b.purchases.push(p);
  return p;
}
export const purchaseBalance = p => (p.voidJournalNo || p.paidImmediately ? 0 : p.amount - sum(p.payments, x => x.amount));
export function purchaseBalanceAt(p, date) {
  if (p.paidImmediately || p.date > date || (p.voidJournalNo && p.voidDate <= date)) return 0;
  return p.amount - sum(p.payments.filter(x => x.date <= date), x => x.amount);
}
export function purchaseStatus(p, today) {
  if (p.voidJournalNo) return 'void';
  if (purchaseBalance(p) === 0) return 'paid';
  if (today && p.dueDate < today) return 'overdue';
  return p.payments.length ? 'part paid' : 'unpaid';
}
/** Pay a bill: Dr Creditors / Cr Bank. */
export function payBill(b, purchaseId, { date, amount }) {
  const p = b.purchases.find(x => x.id === purchaseId); need(p, 'Purchase not found');
  need(!p.voidJournalNo, 'Purchase is void');
  need(Number.isSafeInteger(amount) && amount > 0, 'Payment amount must be greater than zero');
  need(amount <= purchaseBalance(p), 'Payment exceeds the amount owed');
  need(isValidDate(date) && date >= p.date, 'Payment date must be on or after the purchase date');
  const e = postEntry(b.ledger, {
    date, memo: `Bill paid — ${p.number}`,
    lines: [{ account: SYS.AP, debit: amount }, { account: SYS.BANK, credit: amount }],
    source: { type: 'bill-payment', id: p.id },
  });
  const pay = { date, amount, journalNo: e.no }; p.payments.push(pay); return pay;
}
export function voidPurchase(b, purchaseId, { date }) {
  const p = b.purchases.find(x => x.id === purchaseId); need(p, 'Purchase not found');
  need(!p.voidJournalNo, 'Already void');
  need(p.payments.length === 0, 'Bill has payments; it cannot be voided');
  need(!bankLines(b).some(l => l.entryNo === p.journalNo && l.matchedTo), 'This purchase is matched to a bank line; unmatch it first');
  const d = date < p.date ? p.date : date;
  p.voidJournalNo = reverseEntry(b.ledger, p.journalNo, { date: d }).no;
  p.voidDate = d;
  return p;
}

// ---------- bank statement import ----------
function splitCsvLine(line, delim) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === delim) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur); return out.map(s => s.trim());
}
/** "-1,234.50", "(12.00)", "€5", "1234.5-" → signed cents. */
export function parseSignedAmount(s) {
  s = String(s ?? '').trim().replace(/[$€£\s]/g, '');
  if (!s) return 0;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  if (s.endsWith('-')) { neg = !neg; s = s.slice(0, -1); }
  const v = parseAmount(s);
  return neg ? -v : v;
}
/** Irish banks export DD/MM/YYYY, so DMY is the default. ISO dates are always accepted. */
export function parseStatementDate(s, fmt = 'DMY') {
  s = String(s ?? '').trim();
  const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  let y, m, d, mm;
  if ((mm = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s))) [, y, m, d] = mm;
  else if ((mm = /^(\d{1,2})[ -]([A-Za-z]{3})[a-z]*[ -](\d{2,4})$/.exec(s))) { d = mm[1]; m = months[mm[2].toLowerCase()]; y = mm[3]; need(m, `Unrecognised month in "${s}"`); }
  else if ((mm = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s))) {
    if (fmt === 'MDY') [, m, d, y] = mm; else [, d, m, y] = mm;
  } else throw new LedgerError(`Unrecognised date "${s}"`);
  if (String(y).length === 2) y = '20' + y;
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  need(isValidDate(iso), `Invalid date "${s}" (check the date format setting)`);
  return iso;
}
/**
 * Parse a bank CSV export (AIB, BOI, PTSB, Revolut and similar). Detects columns by header name:
 * Date; Description/Details/Narrative; and either Amount, or Debit + Credit. Positive = money in.
 */
export function parseStatementCsv(text, { dateFormat = 'DMY' } = {}) {
  const rows = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  need(rows.length >= 2, 'CSV needs a header row and at least one transaction');
  const delim = (rows[0].match(/;/g) || []).length > (rows[0].match(/,/g) || []).length ? ';' : ',';
  const head = splitCsvLine(rows[0], delim).map(h => h.toLowerCase());
  const find = re => head.findIndex(h => re.test(h));
  let iDate = find(/^(posted |transaction |value )?date|completed date|started date/); if (iDate < 0) iDate = find(/date/);
  const iDesc = find(/desc|detail|narrative|payee|memo|particulars|reference|name/);
  const iAmt = find(/^amount|^amt|^value$/), iOut = find(/debit|withdraw|paid out|money out/), iIn = find(/credit|deposit|lodg|paid in|money in/);
  const iFee = find(/^fee$/);
  need(iDate >= 0, 'No "Date" column found');
  need(iAmt >= 0 || (iOut >= 0 && iIn >= 0), 'Need an "Amount" column, or "Debit" and "Credit" columns');
  return rows.slice(1).map((line, n) => {
    const c = splitCsvLine(line, delim);
    try {
      let amount = iAmt >= 0 ? parseSignedAmount(c[iAmt]) : Math.abs(parseSignedAmount(c[iIn])) - Math.abs(parseSignedAmount(c[iOut]));
      if (iFee >= 0 && c[iFee]) amount -= Math.abs(parseSignedAmount(c[iFee]));
      return { date: parseStatementDate(c[iDate], dateFormat), description: iDesc >= 0 ? c[iDesc] : '', amount };
    } catch (e) { throw new LedgerError(`CSV row ${n + 2}: ${e.message}`); }
  }).filter(r => r.amount !== 0);
}
/** Add parsed lines, skipping ones already imported (same date, amount, description — duplicates within a file are kept). */
export function importStatement(b, lines, { now = new Date().toISOString() } = {}) {
  const key = l => `${l.date}|${l.amount}|${l.description.trim().toLowerCase()}`;
  const existing = new Map();
  b.statement.forEach(l => existing.set(key(l), (existing.get(key(l)) || 0) + 1));
  const seen = new Map(); let added = 0, skipped = 0;
  for (const l of lines) {
    need(isValidDate(l.date) && Number.isSafeInteger(l.amount) && l.amount !== 0, 'Invalid statement line');
    const k = key(l); const n = (seen.get(k) || 0) + 1; seen.set(k, n);
    if (n <= (existing.get(k) || 0)) { skipped++; continue; }
    b.statement.push({ id: nextId(b, 'stmt'), date: l.date, description: String(l.description).trim(), amount: l.amount, match: null, reconciliationId: null, importedAt: now });
    added++;
  }
  b.statement.sort((x, y) => x.date.localeCompare(y.date) || x.id - y.id);
  return { added, skipped };
}
export function deleteStatementLine(b, id) {
  const s = b.statement.find(x => x.id === id); need(s, 'Line not found');
  need(!s.match && !s.reconciliationId, 'Unmatch the line before deleting it');
  b.statement.splice(b.statement.indexOf(s), 1);
}

// ---------- matching ----------
export function bankLines(b) {
  const matched = new Map(b.statement.filter(s => s.match).map(s => [s.match, s.id]));
  const out = [];
  for (const e of b.ledger.entries) e.lines.forEach((l, i) => {
    if (l.account !== SYS.BANK) return;
    const key = `${e.no}:${i}`;
    out.push({ key, entryNo: e.no, date: e.date, memo: e.memo, amount: l.debit - l.credit, matchedTo: matched.get(key) ?? null, isOpening: b.bankOpening?.entryNo === e.no });
  });
  return out;
}
export function suggestMatches(b, stmtId, windowDays = 10) {
  const s = b.statement.find(x => x.id === stmtId); need(s, 'Statement line not found');
  return bankLines(b).filter(l => !l.matchedTo && !l.isOpening && l.amount === s.amount && Math.abs(dayDiff(l.date, s.date)) <= windowDays)
    .sort((x, y) => Math.abs(dayDiff(x.date, s.date)) - Math.abs(dayDiff(y.date, s.date)));
}
export function matchLine(b, stmtId, key) {
  const s = b.statement.find(x => x.id === stmtId); need(s, 'Statement line not found');
  need(!s.match, 'Statement line is already matched');
  const l = bankLines(b).find(x => x.key === key); need(l, 'Ledger line not found');
  need(!l.matchedTo && !l.isOpening, 'Ledger line is already matched');
  need(l.amount === s.amount, 'Amounts differ — matched items must be equal');
  s.match = key;
}
export function unmatchLine(b, stmtId) {
  const s = b.statement.find(x => x.id === stmtId); need(s, 'Statement line not found');
  need(!s.reconciliationId, 'Line is part of a finalised reconciliation');
  s.match = null;
}
/** Match lines with exactly one candidate (same amount, ±3 days) that no other line also wants. */
export function autoMatch(b) {
  let n = 0;
  const open = b.statement.filter(s => !s.match);
  const cands = new Map(open.map(s => [s.id, suggestMatches(b, s.id, 3)]));
  const claims = new Map();
  for (const c of cands.values()) for (const l of c) claims.set(l.key, (claims.get(l.key) || 0) + 1);
  for (const s of open) {
    const c = cands.get(s.id);
    if (c.length === 1 && claims.get(c[0].key) === 1) { matchLine(b, s.id, c[0].key); n++; }
  }
  return n;
}
/** Record an unrecorded bank line (fees, drawings, direct debits…) against an account, and match it. */
export function categorizeLine(b, stmtId, { account: acct, memo }) {
  const s = b.statement.find(x => x.id === stmtId); need(s, 'Statement line not found');
  need(!s.match, 'Already matched');
  need(account(b, acct) && acct !== SYS.BANK, 'Choose an account other than the bank');
  const amt = Math.abs(s.amount), inflow = s.amount > 0;
  const e = postEntry(b.ledger, {
    date: s.date, memo: memo || s.description,
    lines: inflow ? [{ account: SYS.BANK, debit: amt }, { account: acct, credit: amt }] : [{ account: acct, debit: amt }, { account: SYS.BANK, credit: amt }],
    source: { type: 'bank', id: s.id },
  });
  s.match = `${e.no}:${inflow ? 0 : 1}`;
  return e;
}
export function applyLineToInvoice(b, stmtId, invoiceId) {
  const s = b.statement.find(x => x.id === stmtId); need(s && !s.match, 'Statement line not available');
  need(s.amount > 0, 'Only lodgements can pay an invoice');
  const p = recordInvoicePayment(b, invoiceId, { date: s.date, amount: s.amount });
  s.match = `${p.journalNo}:0`;
}
export function applyLineToBill(b, stmtId, purchaseId) {
  const s = b.statement.find(x => x.id === stmtId); need(s && !s.match, 'Statement line not available');
  need(s.amount < 0, 'Only payments out can pay a bill');
  const p = payBill(b, purchaseId, { date: s.date, amount: -s.amount });
  s.match = `${p.journalNo}:1`;
}

// ---------- reconciliation ----------
export const lastReconciliation = b => b.reconciliations[b.reconciliations.length - 1] || null;
export function reconciliationPreview(b, { statementDate, closingBalance }) {
  need(isValidDate(statementDate), 'Statement date is invalid');
  need(Number.isSafeInteger(closingBalance), 'Closing balance is invalid');
  const prev = lastReconciliation(b);
  need(!prev || statementDate > prev.statementDate, `Must be after the last reconciliation (${prev?.statementDate})`);
  const opening = prev ? prev.closingBalance : (b.bankOpening?.amount ?? 0);
  const inPeriod = b.statement.filter(s => !s.reconciliationId && s.date <= statementDate);
  const cleared = inPeriod.filter(s => s.match);
  const unmatched = inPeriod.filter(s => !s.match);
  const clearedTotal = sum(cleared, s => s.amount);
  const all = bankLines(b);
  const outstanding = all.filter(l => !l.matchedTo && !l.isOpening && l.date <= statementDate);
  const bookBalance = sum(all.filter(l => l.date <= statementDate), l => l.amount);
  const difference = closingBalance - (opening + clearedTotal);
  return {
    statementDate, opening, closingBalance, clearedTotal, cleared, unmatched, outstanding, bookBalance,
    outstandingTotal: sum(outstanding, l => l.amount), difference,
    canFinalize: difference === 0 && unmatched.length === 0,
  };
}
export function finalizeReconciliation(b, args, { now = new Date().toISOString() } = {}) {
  const p = reconciliationPreview(b, args);
  need(p.unmatched.length === 0, `${p.unmatched.length} statement line(s) still need matching or categorising`);
  need(p.difference === 0, `Out of balance by ${money(b, p.difference)}`);
  const rec = { id: nextId(b, 'rec'), statementDate: p.statementDate, openingBalance: p.opening, closingBalance: p.closingBalance, lineIds: p.cleared.map(s => s.id), finalizedAt: now };
  p.cleared.forEach(s => (s.reconciliationId = rec.id));
  b.reconciliations.push(rec);
  return rec;
}

// ---------- reports ----------
function netByAccount(b, from, to) {
  const net = new Map(b.ledger.accounts.map(a => [a.code, 0]));
  for (const e of b.ledger.entries) {
    if ((from && e.date < from) || (to && e.date > to)) continue;
    for (const l of e.lines) net.set(l.account, net.get(l.account) + l.debit - l.credit);
  }
  return net;
}
const sorted = accts => [...accts].sort((a, c) => a.code.localeCompare(c.code, undefined, { numeric: true }));
export function profitAndLoss(b, { from, to }) {
  need(isValidDate(from) && isValidDate(to) && from <= to, 'Choose a valid date range');
  const net = netByAccount(b, from, to);
  const rows = t => sorted(b.ledger.accounts.filter(a => a.type === t))
    .map(a => ({ code: a.code, name: a.name, amount: t === 'revenue' ? -net.get(a.code) : net.get(a.code) })).filter(r => r.amount);
  const income = rows('revenue'), expenses = rows('expense');
  const totalIncome = sum(income, r => r.amount), totalExpenses = sum(expenses, r => r.amount);
  return { from, to, income, expenses, totalIncome, totalExpenses, netProfit: totalIncome - totalExpenses };
}
/** Balance sheet; profit is split into prior years (before yearStart) and the current year. */
export function balanceSheet(b, asOf, { yearStart = asOf?.slice(0, 4) + '-01-01' } = {}) {
  need(isValidDate(asOf), 'Choose a valid date');
  const net = netByAccount(b, null, asOf);
  const prior = netByAccount(b, null, addDays(yearStart, -1));
  const rows = (t, sign) => sorted(b.ledger.accounts.filter(a => a.type === t))
    .map(a => ({ code: a.code, name: a.name, amount: sign * net.get(a.code) })).filter(r => r.amount);
  const pl = m => sum(b.ledger.accounts.filter(a => a.type === 'revenue' || a.type === 'expense'), a => -m.get(a.code));
  const assets = rows('asset', 1), liabilities = rows('liability', -1), equity = rows('equity', -1);
  const priorProfit = pl(prior), yearProfit = pl(net) - priorProfit;
  if (priorProfit) equity.push({ code: '', name: 'Profits from earlier years', amount: priorProfit });
  if (yearProfit) equity.push({ code: '', name: 'Profit for the year', amount: yearProfit });
  const totalAssets = sum(assets, r => r.amount), totalLiabilities = sum(liabilities, r => r.amount), totalEquity = sum(equity, r => r.amount);
  return { asOf, assets, liabilities, equity, totalAssets, totalLiabilities, totalEquity, balanced: totalAssets === totalLiabilities + totalEquity };
}

/** VAT registration watch: Irish services threshold, tested on current AND previous calendar year. */
export function vatWatch(b, today) {
  const y = Number(today.slice(0, 4));
  const turnover = year => {
    const n = netByAccount(b, `${year}-01-01`, `${year}-12-31`);
    return sum(b.ledger.accounts.filter(a => a.type === 'revenue' && a.f11 === '128'), a => -n.get(a.code));
  };
  const current = turnover(y), previous = turnover(y - 1), threshold = b.settings.vatThreshold;
  const worst = Math.max(current, previous);
  return {
    current, previous, threshold, year: y,
    pct: threshold ? Math.floor((current * 100) / threshold) : 0,
    status: b.settings.vatRegistered ? 'registered' : worst > threshold ? 'exceeded' : current >= threshold * 0.8 ? 'warning' : 'ok',
  };
}

export function dashboard(b, today) {
  const year = today.slice(0, 4);
  const pl = profitAndLoss(b, { from: `${year}-01-01`, to: today });
  const openInv = b.invoices.filter(i => invoiceBalance(i) > 0);
  const openBills = b.purchases.filter(p => purchaseBalance(p) > 0);
  return {
    bank: sum(bankLines(b).filter(l => l.date <= today), l => l.amount),
    receivable: sum(openInv, invoiceBalance),
    overdue: openInv.filter(i => i.dueDate < today),
    payable: sum(openBills, purchaseBalance),
    billsDue: openBills.filter(p => p.dueDate <= addDays(today, 7)),
    unmatched: b.statement.filter(s => !s.match).length,
    lastReconciled: lastReconciliation(b)?.statementDate ?? null,
    ytd: pl,
    vat: vatWatch(b, today),
  };
}

// ---------- year end & Form 11 ----------
/**
 * Form 11 "Extracts From Accounts" [124–168] for an accounting period, from the ledger.
 * Figures are whole euro (Revenue's form uses .00); exact cents are kept alongside.
 * Adjustment lines (160–168) are *suggestions* — the private-use element of motor and
 * light/heat/phone needs your judgement.
 */
export function form11Extracts(b, { from, to }) {
  need(isValidDate(from) && isValidDate(to) && from <= to, 'Choose a valid accounting period');
  const period = netByAccount(b, from, to);
  const close = netByAccount(b, null, to);
  const accts = b.ledger.accounts;
  const lines = {};
  const add = (k, v) => (lines[k] = (lines[k] || 0) + v);
  // P&L lines: credit-balance expense accounts go to 144 / 142(b) as negatives.
  for (const a of accts) {
    const n = period.get(a.code);
    if (!n) continue;
    if (a.type === 'revenue') add(a.f11 || '130', -n);
    if (a.type === 'expense') {
      const line = a.f11 || '143';
      if (n >= 0) add(line === '142' ? '142a' : line, n);
      else add(line === '142' ? '142b' : line === '143' ? '144' : line, line === '142' || line === '143' ? -n : n);
    }
  }
  const income = (lines['128'] || 0) + (lines['129'] || 0) + (lines['130'] || 0);
  lines['132'] = income - (lines['131'] || 0);
  const expenseTotal = ['133', '134', '135', '136', '137', '138', '139', '140', '141', '142a', '143'].reduce((s, k) => s + (lines[k] || 0), 0) - (lines['142b'] || 0) - (lines['144'] || 0);
  const profit = lines['132'] - expenseTotal;
  if (profit >= 0) lines['157'] = profit; else lines['158'] = -profit;
  // Capital account & balance sheet at period end.
  const bal = code => close.get(code) ?? 0;
  const byTag = (tag, sign) => sum(accts.filter(a => a.f11 === tag), a => sign * bal(a.code));
  lines['145'] = -sum(accts.filter(a => a.f11 === '145'), a => period.get(a.code));
  lines['146'] = sum(accts.filter(a => a.f11 === '146'), a => period.get(a.code));
  const bank = byTag('150', 1);
  if (bank >= 0) lines['150'] = bank; else lines['151'] = -bank;
  lines['151'] = (lines['151'] || 0) + byTag('151', -1);
  lines['149'] = byTag('149', 1);
  lines['154'] = byTag('154', -1);
  lines['155'] = byTag('155', -1);
  const assets = sum(accts.filter(a => a.type === 'asset'), a => bal(a.code));
  const liabilities = sum(accts.filter(a => a.type === 'liability'), a => -bal(a.code));
  const netAssets = assets - liabilities;
  if (netAssets >= 0) lines['156a'] = netAssets; else lines['156b'] = -netAssets;
  const capital = -sum(accts.filter(a => a.type !== 'asset' && a.type !== 'liability'), a => bal(a.code));
  if (capital >= 0) lines['147a'] = capital; else lines['147b'] = -capital;
  // Suggested adjustments
  const tot = codes => sum(codes, c => period.get(c) ?? 0);
  const adjustments = {
    '160': { amount: tot(['5200']), note: 'Motor expenses — enter only the PRIVATE-use portion as the add-back' },
    '161': { amount: tot(['5900', '5910']), note: 'Entertainment and donations — generally added back in full' },
    '162': { amount: tot(['5400', '5410']), note: 'Light, heat & phone — enter only the PRIVATE-use portion' },
    '167': { amount: lines['141'] || 0, note: 'Depreciation is added back (relief comes via capital allowances)' },
  };
  const ordered = Object.keys(lines).sort((x, y) => parseFloat(x) - parseFloat(y) || x.localeCompare(y));
  const euro = c => (c >= 0 ? roundDiv(c, 100) : -roundDiv(-c, 100));
  return {
    from, to,
    rows: ordered.filter(k => lines[k]).map(k => ({ line: k, label: f11Label(k), cents: lines[k], euro: euro(lines[k]) })),
    lines, adjustments, profit, netAssets, capital,
    checks: {
      capitalEqualsNetAssets: capital === netAssets,
      trialBalanced: trialBalance(b.ledger, to).balanced,
    },
  };
}
function f11Label(k) {
  const extra = { '142a': 'Provisions incl. bad debts — positive', '142b': 'Provisions incl. bad debts — negative', '144': 'Other Expenses — negative / credit entries',
    '132': 'Gross Trading Profits', '157': 'Net Trade Profit per Accounts', '158': 'Net Trade Loss per Accounts',
    '147a': 'Closing Capital Balance — positive', '147b': 'Closing Capital Balance — negative', '156a': 'Net Assets — positive', '156b': 'Net Assets — negative' };
  return extra[k] || F11_LINES[k] || k;
}

/** Wear & tear estimate: 12.5% straight line over 8 years on equipment bought (account 1500). */
export function capitalAllowances(b, { to }) {
  const year = Number(to.slice(0, 4));
  const assets = b.purchases.filter(p => p.account === SYS.FIXED && !p.voidJournalNo && p.date <= to);
  const rows = assets.map(p => {
    const firstYear = Number(p.date.slice(0, 4));
    const yearsClaimed = year - firstYear; // years before this one
    const annual = roundDiv(p.amount * 125, 1000);
    const allowance = yearsClaimed < 8 ? (yearsClaimed === 7 ? p.amount - annual * 7 : annual) : 0;
    return { number: p.number, date: p.date, description: p.description || b.vendors.find(v => v.id === p.vendorId)?.name, cost: p.amount, yearOfClaim: yearsClaimed + 1, allowance };
  });
  return { rows, total: sum(rows, r => r.allowance) };
}

export function yearEndChecklist(b, { from, to }) {
  const rec = lastReconciliation(b);
  const tb = trialBalance(b.ledger, to);
  const debtors = b.invoices.map(i => ({ inv: i, bal: invoiceBalanceAt(i, to) })).filter(x => x.bal > 0);
  const creditors = b.purchases.map(p => ({ p, bal: purchaseBalanceAt(p, to) })).filter(x => x.bal > 0);
  const unmatched = b.statement.filter(s => !s.match && s.date <= to);
  const fixed = b.ledger.accounts.filter(a => a.f11 === 'FA');
  const hasAssets = netByAccount(b, null, to).get(SYS.FIXED) > 0;
  const depPosted = (netByAccount(b, from, to).get(SYS.DEPRECIATION) ?? 0) > 0;
  return {
    items: [
      { ok: tb.balanced, label: 'Trial balance balances' },
      { ok: !!rec && rec.statementDate >= to, label: `Bank reconciled to ${dmy(to)}`, detail: rec ? `Last reconciled to ${dmy(rec.statementDate)}` : 'Not reconciled yet' },
      { ok: unmatched.length === 0, label: 'All bank lines up to year end matched or categorised', detail: `${unmatched.length} unmatched` },
      { ok: true, info: true, label: `Debtors at year end: ${money(b, sum(debtors, x => x.bal))}`, detail: `${debtors.length} unpaid invoice(s) — review for bad debts` },
      { ok: true, info: true, label: `Creditors at year end: ${money(b, sum(creditors, x => x.bal))}`, detail: `${creditors.length} unpaid bill(s)` },
      { ok: !hasAssets || depPosted, label: 'Depreciation posted for equipment', detail: hasAssets ? (depPosted ? 'Posted' : 'Equipment held but no depreciation this year') : 'No equipment' },
      { ok: b.ledger.lockDate >= to, label: `Year locked through ${dmy(to)}`, detail: b.ledger.lockDate ? `Locked through ${dmy(b.ledger.lockDate)}` : 'Not locked' },
    ],
    debtors, creditors, fixedAccounts: fixed.map(a => a.code),
  };
}

/** Post depreciation for the year: Dr Depreciation / Cr Accumulated Depreciation. */
export function postDepreciation(b, { date, amount }) {
  need(Number.isSafeInteger(amount) && amount > 0, 'Depreciation must be greater than zero');
  return postEntry(b.ledger, {
    date, memo: `Depreciation for year ended ${date}`,
    lines: [{ account: SYS.DEPRECIATION, debit: amount }, { account: SYS.ACC_DEP, credit: amount }],
    source: { type: 'depreciation' },
  });
}

// ---------- persistence ----------
export function lockBooks(b, date) { setLockDate(b.ledger, date); }
export function serialize(b) { return JSON.parse(JSON.stringify(b)); }
/** Rebuild books from JSON; every journal entry is re-validated and document links checked. */
export function loadBooks(data) {
  need(data && data.version === 3, 'Unsupported or corrupt data file');
  const b = structuredClone({ ...data, ledger: null });
  b.ledger = loadLedger(data.ledger);
  const has = no => b.ledger.entries.some(e => e.no === no);
  for (const d of [...b.invoices, ...b.purchases]) {
    need(has(d.journalNo) && (!d.voidJournalNo || has(d.voidJournalNo)) && d.payments.every(p => has(p.journalNo)), `Document ${d.number} links to a missing journal entry`);
  }
  for (const i of b.invoices) need(i.total === i.subtotal + i.tax, `Invoice ${i.number} totals are inconsistent`);
  return b;
}

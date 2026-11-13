// Core double-entry engine. Pure functions, no DOM, no floating point.
// All money is stored as integer cents (Number, guarded by Number.isSafeInteger).

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'];
// Normal balance side per account type.
export const NORMAL_SIDE = { asset: 'debit', expense: 'debit', liability: 'credit', equity: 'credit', revenue: 'credit' };

export class LedgerError extends Error {
  constructor(message) { super(message); this.name = 'LedgerError'; }
}

/** Parse a user-entered amount like "1,234.5" into integer cents. Rejects >2 decimals, negatives, junk. */
export function parseAmount(input) {
  if (typeof input === 'number') input = String(input);
  if (typeof input !== 'string') throw new LedgerError('Amount must be text or number');
  const s = input.trim().replace(/,/g, '');
  if (s === '') return 0;
  const m = /^(\d+)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) throw new LedgerError(`Invalid amount "${input}" (use positive numbers with up to 2 decimals)`);
  const cents = Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new LedgerError('Amount too large');
  return cents;
}

export function formatCents(cents, currency = 'USD') {
  if (!Number.isSafeInteger(cents)) throw new LedgerError('Not an integer cent value');
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  const frac = String(abs % 100).padStart(2, '0');
  const sym = { USD: '$', EUR: '€', GBP: '£' }[currency] ?? '';
  return `${neg ? '-' : ''}${sym}${whole}.${frac}${sym ? '' : ' ' + currency}`;
}

function isValidDate(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const dt = new Date(d + 'T00:00:00Z');
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === d;
}

export function createLedger({ name = 'Untitled', currency = 'USD' } = {}) {
  return { version: 1, name, currency, accounts: [], entries: [], nextEntryNo: 1, lockDate: null };
}

export function addAccount(ledger, { code, name, type, f11 = null }) {
  code = String(code ?? '').trim();
  name = String(name ?? '').trim();
  if (!code) throw new LedgerError('Account code is required');
  if (!name) throw new LedgerError('Account name is required');
  if (!ACCOUNT_TYPES.includes(type)) throw new LedgerError(`Account type must be one of ${ACCOUNT_TYPES.join(', ')}`);
  if (ledger.accounts.some(a => a.code === code)) throw new LedgerError(`Account code ${code} already exists`);
  const account = { code, name, type, f11: f11 || null };
  ledger.accounts.push(account);
  return account;
}

/**
 * Validate a draft entry. Returns normalized entry (without number) or throws.
 * lines: [{ account, debit, credit }] where debit/credit are integer cents (one must be 0).
 */
export function validateEntry(ledger, { date, memo = '', lines }) {
  if (!isValidDate(date)) throw new LedgerError('Entry date must be a valid YYYY-MM-DD date');
  if (ledger.lockDate && date <= ledger.lockDate) throw new LedgerError(`Books are locked through ${ledger.lockDate}; use a later date`);
  if (!Array.isArray(lines)) throw new LedgerError('Entry lines are required');
  const clean = lines
    .map(l => ({ account: String(l.account ?? '').trim(), debit: l.debit ?? 0, credit: l.credit ?? 0, note: String(l.note ?? '') }))
    .filter(l => l.account || l.debit || l.credit);
  if (clean.length < 2) throw new LedgerError('An entry needs at least two lines');
  let dr = 0, cr = 0;
  clean.forEach((l, i) => {
    const n = i + 1;
    if (!ledger.accounts.some(a => a.code === l.account)) throw new LedgerError(`Line ${n}: unknown account "${l.account}"`);
    for (const k of ['debit', 'credit']) {
      if (!Number.isSafeInteger(l[k]) || l[k] < 0) throw new LedgerError(`Line ${n}: ${k} must be a non-negative integer amount of cents`);
    }
    if (l.debit > 0 && l.credit > 0) throw new LedgerError(`Line ${n}: use either debit or credit, not both`);
    if (l.debit === 0 && l.credit === 0) throw new LedgerError(`Line ${n}: amount is zero`);
    dr += l.debit; cr += l.credit;
  });
  if (!Number.isSafeInteger(dr) || !Number.isSafeInteger(cr)) throw new LedgerError('Totals overflow');
  if (dr !== cr) throw new LedgerError(`Entry is unbalanced: debits ${formatCents(dr, ledger.currency)} ≠ credits ${formatCents(cr, ledger.currency)}`);
  return { date, memo: String(memo).trim(), lines: clean, total: dr };
}

/** Post an entry. Entries are append-only: there is no edit or delete, only reversal. */
export function postEntry(ledger, draft, { now = new Date().toISOString() } = {}) {
  const v = validateEntry(ledger, draft);
  const entry = Object.freeze({
    no: ledger.nextEntryNo,
    ...v,
    lines: Object.freeze(v.lines.map(l => Object.freeze({ ...l }))),
    postedAt: now,
    reverses: draft.reverses ?? null,
    source: draft.source ? Object.freeze({ ...draft.source }) : null,
  });
  ledger.entries.push(entry);
  ledger.nextEntryNo += 1;
  return entry;
}

export function reverseEntry(ledger, no, { date, now } = {}) {
  const orig = ledger.entries.find(e => e.no === no);
  if (!orig) throw new LedgerError(`Entry #${no} not found`);
  if (ledger.entries.some(e => e.reverses === no)) throw new LedgerError(`Entry #${no} is already reversed`);
  if (orig.reverses != null) throw new LedgerError(`Entry #${no} is itself a reversal`);
  return postEntry(ledger, {
    date: date ?? orig.date,
    memo: `Reversal of #${no}${orig.memo ? ': ' + orig.memo : ''}`,
    lines: orig.lines.map(l => ({ account: l.account, debit: l.credit, credit: l.debit, note: l.note })),
    reverses: no,
    source: orig.source,
  }, { now });
}

/** Trial balance as of a date (inclusive). Each account shows its net balance in the debit or credit column. */
export function trialBalance(ledger, asOf = null) {
  if (asOf != null && !isValidDate(asOf)) throw new LedgerError('As-of date must be YYYY-MM-DD');
  const net = new Map(ledger.accounts.map(a => [a.code, 0]));
  for (const e of ledger.entries) {
    if (asOf && e.date > asOf) continue;
    for (const l of e.lines) net.set(l.account, net.get(l.account) + l.debit - l.credit);
  }
  const rows = ledger.accounts
    .map(a => {
      const n = net.get(a.code);
      return { code: a.code, name: a.name, type: a.type, debit: n > 0 ? n : 0, credit: n < 0 ? -n : 0 };
    })
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  const totalDebit = rows.reduce((s, r) => s + r.debit, 0);
  const totalCredit = rows.reduce((s, r) => s + r.credit, 0);
  return { asOf, rows, totalDebit, totalCredit, balanced: totalDebit === totalCredit };
}

/** Starter chart of accounts for a freelance service business. */
export const DEFAULT_CHART = [
  { code: '1000', name: 'Business Bank Account', type: 'asset' },
  { code: '1100', name: 'Accounts Receivable', type: 'asset' },
  { code: '2000', name: 'Accounts Payable', type: 'liability' },
  { code: '2100', name: 'Sales Tax Payable', type: 'liability' },
  { code: '3000', name: "Owner's Capital", type: 'equity' },
  { code: '3100', name: "Owner's Draw", type: 'equity' },
  { code: '4000', name: 'Service Revenue', type: 'revenue' },
  { code: '4100', name: 'Other Income', type: 'revenue' },
  { code: '5000', name: 'Software & Subscriptions', type: 'expense' },
  { code: '5100', name: 'Office Supplies', type: 'expense' },
  { code: '5200', name: 'Rent & Home Office', type: 'expense' },
  { code: '5300', name: 'Professional Fees', type: 'expense' },
  { code: '5400', name: 'Travel', type: 'expense' },
  { code: '5500', name: 'Meals', type: 'expense' },
  { code: '5600', name: 'Bank Fees', type: 'expense' },
  { code: '5700', name: 'Phone & Internet', type: 'expense' },
  { code: '5800', name: 'Advertising & Marketing', type: 'expense' },
  { code: '5900', name: 'Training & Education', type: 'expense' },
];

/** Close the books through a date (e.g. after filing a tax return). Null unlocks. */
export function setLockDate(ledger, date) {
  if (date != null && date !== '' && !isValidDate(date)) throw new LedgerError('Lock date must be YYYY-MM-DD');
  ledger.lockDate = date || null;
}

export { isValidDate };

/** Rebuild a ledger from saved JSON, re-validating every entry so corrupted data is caught. */
export function loadLedger(data) {
  if (!data || data.version !== 1) throw new LedgerError('Unsupported or corrupt ledger data');
  const l = createLedger({ name: data.name, currency: data.currency });
  for (const a of data.accounts) addAccount(l, a);
  for (const e of [...data.entries].sort((x, y) => x.no - y.no)) {
    if (e.no !== l.nextEntryNo) throw new LedgerError(`Entry numbering gap at #${e.no}`);
    postEntry(l, e, { now: e.postedAt });
  }
  if (data.lockDate) setLockDate(l, data.lockDate);
  return l;
}

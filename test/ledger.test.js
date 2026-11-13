import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLedger, addAccount, postEntry, reverseEntry, trialBalance, parseAmount,
  formatCents, loadLedger, DEFAULT_CHART, LedgerError,
} from '../src/ledger.js';

const setup = () => {
  const l = createLedger({ name: 'Acme' });
  DEFAULT_CHART.forEach(a => addAccount(l, a));
  return l;
};
const line = (account, debit = 0, credit = 0) => ({ account, debit, credit });

test('parseAmount converts to integer cents without float errors', () => {
  assert.equal(parseAmount('0.1'), 10);
  assert.equal(parseAmount('0.29'), 29);
  assert.equal(parseAmount('1,234.56'), 123456);
  assert.equal(parseAmount('5'), 500);
  assert.equal(parseAmount(''), 0);
  for (const bad of ['-1', '1.234', 'abc', '1e5', '1.2.3']) assert.throws(() => parseAmount(bad), LedgerError);
});

test('formatCents', () => {
  assert.equal(formatCents(123456), '$1,234.56');
  assert.equal(formatCents(-5), '-$0.05');
  assert.equal(formatCents(100, 'JPY'), '1.00 JPY');
});

test('posts a balanced entry with sequential numbers', () => {
  const l = setup();
  const e1 = postEntry(l, { date: '2026-01-05', memo: 'Invoice', lines: [line('1100', 50000), line('4000', 0, 50000)] });
  const e2 = postEntry(l, { date: '2026-01-10', lines: [line('1000', 50000), line('1100', 0, 50000)] });
  assert.equal(e1.no, 1); assert.equal(e2.no, 2); assert.equal(e1.total, 50000);
});

test('rejects unbalanced entries and leaves ledger untouched', () => {
  const l = setup();
  assert.throws(() => postEntry(l, { date: '2026-01-05', lines: [line('1000', 100), line('4000', 0, 99)] }), /unbalanced/);
  assert.equal(l.entries.length, 0);
  assert.equal(l.nextEntryNo, 1);
});

test('rejects malformed lines', () => {
  const l = setup();
  const d = '2026-01-05';
  assert.throws(() => postEntry(l, { date: d, lines: [line('1000', 100)] }), /at least two/);
  assert.throws(() => postEntry(l, { date: d, lines: [line('9999', 100), line('4000', 0, 100)] }), /unknown account/);
  assert.throws(() => postEntry(l, { date: d, lines: [line('1000', 100, 100), line('4000', 0, 0)] }), /not both/);
  assert.throws(() => postEntry(l, { date: d, lines: [line('1000', 0.5), line('4000', 0, 0.5)] }), /integer/);
  assert.throws(() => postEntry(l, { date: d, lines: [line('1000', -100), line('4000', -100)] }), /non-negative/);
  assert.throws(() => postEntry(l, { date: d, lines: [line('1000', 100), line('4000', 0, 100), line('5000', 0, 0)] }), /zero/);
});

test('rejects invalid dates', () => {
  const l = setup();
  for (const date of ['2026-02-30', '2026/01/01', '', undefined]) {
    assert.throws(() => postEntry(l, { date, lines: [line('1000', 1), line('4000', 0, 1)] }), /date/);
  }
});

test('blank rows from the UI are ignored', () => {
  const l = setup();
  const e = postEntry(l, { date: '2026-01-05', lines: [line('1000', 100), line('', 0, 0), line('4000', 0, 100)] });
  assert.equal(e.lines.length, 2);
});

test('posted entries are immutable', () => {
  const l = setup();
  const e = postEntry(l, { date: '2026-01-05', lines: [line('1000', 100), line('4000', 0, 100)] });
  assert.throws(() => { e.lines[0].debit = 999; }, TypeError);
  assert.throws(() => { e.memo = 'x'; }, TypeError);
});

test('compound entry (3+ lines) and trial balance', () => {
  const l = setup();
  postEntry(l, { date: '2026-01-01', lines: [line('1000', 1000000), line('3000', 0, 1000000)] });
  postEntry(l, { date: '2026-01-05', lines: [line('1100', 107500), line('4000', 0, 100000), line('2100', 0, 7500)] });
  postEntry(l, { date: '2026-01-31', lines: [line('5000', 150000), line('1000', 0, 150000)] });
  const tb = trialBalance(l);
  assert.equal(tb.balanced, true);
  assert.equal(tb.totalDebit, 1000000 - 150000 + 107500 + 150000);
  const row = c => tb.rows.find(r => r.code === c);
  assert.deepEqual([row('1000').debit, row('1000').credit], [850000, 0]);
  assert.equal(row('4000').credit, 100000);
  assert.equal(row('2100').credit, 7500);
  assert.equal(row('5200').debit + row('5200').credit, 0);
});

test('trial balance as-of date excludes later entries', () => {
  const l = setup();
  postEntry(l, { date: '2026-01-01', lines: [line('1000', 500), line('3000', 0, 500)] });
  postEntry(l, { date: '2026-02-01', lines: [line('5000', 200), line('1000', 0, 200)] });
  assert.equal(trialBalance(l, '2026-01-31').totalDebit, 500);
  assert.equal(trialBalance(l, '2026-02-01').rows.find(r => r.code === '1000').debit, 300);
  assert.throws(() => trialBalance(l, 'bad'), LedgerError);
});

test('reversal zeroes out the original and cannot be repeated', () => {
  const l = setup();
  postEntry(l, { date: '2026-01-05', lines: [line('5200', 4999), line('1000', 0, 4999)] });
  const r = reverseEntry(l, 1, { date: '2026-01-06' });
  assert.equal(r.reverses, 1);
  assert.equal(l.entries.length, 2, 'original kept for audit trail');
  assert.ok(trialBalance(l).rows.every(x => x.debit === 0 && x.credit === 0));
  assert.throws(() => reverseEntry(l, 1), /already reversed/);
  assert.throws(() => reverseEntry(l, 2), /itself a reversal/);
  assert.throws(() => reverseEntry(l, 42), /not found/);
});

test('accounts: validation and duplicates', () => {
  const l = setup();
  assert.throws(() => addAccount(l, { code: '1000', name: 'Dup', type: 'asset' }), /exists/);
  assert.throws(() => addAccount(l, { code: '9', name: 'X', type: 'income' }), /type/);
  assert.throws(() => addAccount(l, { code: '', name: 'X', type: 'asset' }), /code/);
});

test('save/load round-trip re-validates data', () => {
  const l = setup();
  postEntry(l, { date: '2026-01-05', lines: [line('1000', 100), line('4000', 0, 100)] });
  const copy = loadLedger(JSON.parse(JSON.stringify(l)));
  assert.deepEqual(trialBalance(copy), trialBalance(l));
  const tampered = JSON.parse(JSON.stringify(l));
  tampered.entries[0].lines[0].debit = 101;
  assert.throws(() => loadLedger(tampered), /unbalanced/);
  assert.throws(() => loadLedger({ version: 99 }), /Unsupported/);
});

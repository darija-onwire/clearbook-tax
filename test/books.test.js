import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as B from '../src/books.js';
import { trialBalance, formatCents } from '../src/ledger.js';

const fresh = () => {
  const b = B.createBooks();
  B.setOpeningBalance(b, { date: '2025-01-01', amount: 100000 }); // €1,000
  return b;
};
const client = b => B.addCustomer(b, { name: 'Murphy Plumbing Ltd', address: 'Cork' });
const tbOk = b => assert.equal(trialBalance(b.ledger).balanced, true);

test('defaults: EUR, ClearBooks, not VAT registered, Irish chart mapped to Form 11', () => {
  const b = B.createBooks();
  assert.equal(b.settings.currency, 'EUR');
  assert.equal(b.settings.businessName, 'ClearBooks Tax & Payroll');
  assert.equal(b.settings.vatRegistered, false);
  assert.ok(b.ledger.accounts.every(a => a.f11 === null || B.F11_LINES[a.f11]));
  assert.equal(formatCents(123456, 'EUR'), '€1,234.56');
});

test('invoice: totals with integer rounding, posts Dr Debtors / Cr Fee income', () => {
  const b = fresh(); const c = client(b);
  const inv = B.createInvoice(b, { customerId: c.id, date: '2025-03-01', items: [
    { description: 'Payroll — March', qty: '1', unitPrice: '150.00' },
    { description: 'Tax advice', qty: '1.5', unitPrice: '85.33' }, // 127.995 → 128.00
  ] });
  assert.equal(inv.number, 'INV-0001');
  assert.equal(inv.total, 15000 + 12800);
  assert.equal(inv.tax, 0);
  assert.equal(inv.dueDate, '2025-03-31');
  const e = b.ledger.entries.find(x => x.no === inv.journalNo);
  assert.deepEqual(e.lines.map(l => [l.account, l.debit, l.credit]), [['1100', 27800, 0], ['4000', 0, 27800]]);
  tbOk(b);
});

test('invoice: VAT is refused while not VAT registered', () => {
  const b = fresh(); const c = client(b);
  assert.throws(() => B.createInvoice(b, { customerId: c.id, date: '2025-03-01', taxBp: 2300, items: [{ description: 'x', qty: '1', unitPrice: '100' }] }), /not VAT registered/);
  assert.equal(b.invoices.length, 0);
});

test('invoice: validation', () => {
  const b = fresh(); const c = client(b);
  const d = '2025-03-01';
  assert.throws(() => B.createInvoice(b, { customerId: 99, date: d, items: [{ description: 'x', qty: '1', unitPrice: '1' }] }), /customer/);
  assert.throws(() => B.createInvoice(b, { customerId: c.id, date: d, items: [] }), /at least one/);
  assert.throws(() => B.createInvoice(b, { customerId: c.id, date: d, items: [{ description: '', qty: '1', unitPrice: '1' }] }), /description/);
  assert.throws(() => B.createInvoice(b, { customerId: c.id, date: d, items: [{ description: 'x', qty: '0', unitPrice: '1' }] }), /quantity/);
  assert.throws(() => B.createInvoice(b, { customerId: c.id, date: d, dueDate: '2025-02-01', items: [{ description: 'x', qty: '1', unitPrice: '1' }] }), /Due date/);
  assert.equal(b.seq.invoice, 1, 'failed invoices do not consume numbers');
});

test('invoice payments: partial, full, overpayment rejected, status', () => {
  const b = fresh(); const c = client(b);
  const inv = B.createInvoice(b, { customerId: c.id, date: '2025-03-01', items: [{ description: 'Fee', qty: '1', unitPrice: '500' }] });
  assert.equal(B.invoiceStatus(inv, '2025-03-05'), 'open');
  assert.equal(B.invoiceStatus(inv, '2025-04-15'), 'overdue');
  B.recordInvoicePayment(b, inv.id, { date: '2025-03-10', amount: 20000 });
  assert.equal(B.invoiceStatus(inv, '2025-03-11'), 'part paid');
  assert.throws(() => B.recordInvoicePayment(b, inv.id, { date: '2025-03-11', amount: 30001 }), /exceeds/);
  assert.throws(() => B.recordInvoicePayment(b, inv.id, { date: '2025-02-01', amount: 100 }), /on or after/);
  B.recordInvoicePayment(b, inv.id, { date: '2025-03-20', amount: 30000 });
  assert.equal(B.invoiceStatus(inv), 'paid');
  assert.equal(B.invoiceBalanceAt(inv, '2025-03-15'), 30000);
  assert.throws(() => B.voidInvoice(b, inv.id, { date: '2025-03-21' }), /payments/);
  tbOk(b);
});

test('void invoice reverses its entry; write-off posts bad debt', () => {
  const b = fresh(); const c = client(b);
  const a = B.createInvoice(b, { customerId: c.id, date: '2025-03-01', items: [{ description: 'A', qty: '1', unitPrice: '100' }] });
  B.voidInvoice(b, a.id, { date: '2025-03-02' });
  assert.equal(B.invoiceStatus(a), 'void');
  const x = B.createInvoice(b, { customerId: c.id, date: '2025-03-01', items: [{ description: 'B', qty: '1', unitPrice: '300' }] });
  B.recordInvoicePayment(b, x.id, { date: '2025-03-05', amount: 10000 });
  B.writeOffInvoice(b, x.id, { date: '2025-12-31' });
  assert.equal(B.invoiceStatus(x), 'written off');
  const pl = B.profitAndLoss(b, { from: '2025-01-01', to: '2025-12-31' });
  assert.equal(pl.totalIncome, 30000);
  assert.equal(pl.expenses.find(r => r.code === '5800').amount, 20000);
  tbOk(b);
});

test('purchases: paid now, bill later, pay bill, overpay rejected, void', () => {
  const b = fresh();
  const p1 = B.recordPurchase(b, { vendor: 'Sage', date: '2025-02-01', account: '5500', amount: 4999, paid: true });
  assert.equal(B.purchaseStatus(p1), 'paid');
  const p2 = B.recordPurchase(b, { vendor: 'CTA Ireland', date: '2025-02-01', dueDate: '2025-03-01', account: '5150', amount: 35000, paid: false });
  assert.equal(B.purchaseStatus(p2, '2025-02-10'), 'unpaid');
  assert.equal(B.purchaseStatus(p2, '2025-03-02'), 'overdue');
  assert.throws(() => B.payBill(b, p2.id, { date: '2025-02-15', amount: 35001 }), /exceeds/);
  B.payBill(b, p2.id, { date: '2025-02-15', amount: 35000 });
  assert.equal(B.purchaseStatus(p2), 'paid');
  assert.equal(b.vendors.length, 2);
  B.recordPurchase(b, { vendor: 'sage', date: '2025-03-01', account: '5500', amount: 4999 });
  assert.equal(b.vendors.length, 2, 'supplier names are de-duplicated case-insensitively');
  assert.throws(() => B.recordPurchase(b, { vendor: 'X', date: '2025-03-01', account: '1000', amount: 1 }), /expense/);
  assert.throws(() => B.recordPurchase(b, { vendor: 'X', date: '2025-03-01', account: '4000', amount: 1 }), /expense/);
  const p3 = B.recordPurchase(b, { vendor: 'X', date: '2025-03-01', account: '5510', amount: 1000, paid: false });
  B.voidPurchase(b, p3.id, { date: '2025-03-02' });
  assert.equal(B.purchaseStatus(p3), 'void');
  tbOk(b);
});

test('CSV parsing: Irish DD/MM/YYYY, signed amounts, debit/credit columns, quotes, BOM', () => {
  const aib = '\uFEFFPosted Account,Posted Transactions Date,Description1,Debit Amount,Credit Amount,Balance\n' +
    '"IE00",15/03/2025,"MURPHY PLUMBING, LTD",,"1,250.00",2250.00\n' +
    '"IE00",16/03/2025,SAGE SUBS,49.99,,2200.01\n';
  const rows = B.parseStatementCsv(aib);
  assert.deepEqual(rows, [
    { date: '2025-03-15', description: 'MURPHY PLUMBING, LTD', amount: 125000 },
    { date: '2025-03-16', description: 'SAGE SUBS', amount: -4999 },
  ]);
  const rev = 'Type,Started Date,Completed Date,Description,Amount,Fee,Currency\nCARD,2025-03-01 10:00:00,2025-03-02 09:00:00,Adobe,-24.59,0.00,EUR\nTOPUP,2025-03-03 10:00:00,2025-03-03 10:00:00,Transfer,500.00,0.50,EUR\n';
  const r2 = B.parseStatementCsv(rev);
  assert.deepEqual(r2.map(r => [r.date, r.amount]), [['2025-03-01', -2459], ['2025-03-03', 49950]]);
  assert.equal(B.parseStatementDate('03/04/2025'), '2025-04-03');
  assert.equal(B.parseStatementDate('03/04/2025', 'MDY'), '2025-03-04');
  assert.equal(B.parseStatementDate('5 Mar 2025'), '2025-03-05');
  assert.equal(B.parseSignedAmount('(12.50)'), -1250);
  assert.equal(B.parseSignedAmount('€1,000.00'), 100000);
  assert.throws(() => B.parseStatementCsv('Foo,Bar\n1,2'), /Date/);
  assert.throws(() => B.parseStatementCsv('Date,Amount\n31/02/2025,5'), /row 2/);
});

test('statement import skips duplicates on re-import but keeps genuine repeats', () => {
  const b = fresh();
  const lines = [
    { date: '2025-03-01', description: 'Coffee', amount: -350 },
    { date: '2025-03-01', description: 'Coffee', amount: -350 },
  ];
  assert.deepEqual(B.importStatement(b, lines), { added: 2, skipped: 0 });
  assert.deepEqual(B.importStatement(b, [...lines, { date: '2025-03-02', description: 'x', amount: 1 }]), { added: 1, skipped: 2 });
});

test('matching, categorising, applying to invoices and bills, auto-match', () => {
  const b = fresh(); const c = client(b);
  const inv = B.createInvoice(b, { customerId: c.id, date: '2025-03-01', items: [{ description: 'Fee', qty: '1', unitPrice: '1250' }] });
  const bill = B.recordPurchase(b, { vendor: 'Eir', date: '2025-03-01', account: '5410', amount: 6000, paid: false });
  B.recordPurchase(b, { vendor: 'Sage', date: '2025-03-15', account: '5500', amount: 4999 });
  B.importStatement(b, [
    { date: '2025-03-10', description: 'MURPHY', amount: 125000 },
    { date: '2025-03-12', description: 'EIR DD', amount: -6000 },
    { date: '2025-03-16', description: 'SAGE', amount: -4999 },
    { date: '2025-03-31', description: 'BANK FEE', amount: -1250 },
  ]);
  const [s1, s2, s3, s4] = b.statement;
  assert.equal(B.autoMatch(b), 1, 'only the Sage line has a recorded counterpart');
  assert.ok(s3.match);
  B.applyLineToInvoice(b, s1.id, inv.id);
  assert.equal(B.invoiceStatus(inv), 'paid');
  assert.throws(() => B.applyLineToBill(b, s1.id, bill.id), /not available/);
  B.applyLineToBill(b, s2.id, bill.id);
  assert.equal(B.purchaseStatus(bill), 'paid');
  B.categorizeLine(b, s4.id, { account: '5540' });
  assert.ok(b.statement.every(s => s.match));
  assert.throws(() => B.matchLine(b, s4.id, s3.match), /already matched/);
  B.unmatchLine(b, s3.id);
  assert.equal(B.suggestMatches(b, s3.id).length, 1);
  tbOk(b);
});

test('matching rejects different amounts', () => {
  const b = fresh();
  B.recordPurchase(b, { vendor: 'A', date: '2025-03-01', account: '5510', amount: 1000 });
  B.importStatement(b, [{ date: '2025-03-01', description: 'A', amount: -1001 }]);
  const key = B.bankLines(b).find(l => !l.isOpening).key;
  assert.throws(() => B.matchLine(b, b.statement[0].id, key), /Amounts differ/);
});

test('reconciliation: difference, unmatched block, finalise, sequential', () => {
  const b = fresh();
  B.recordPurchase(b, { vendor: 'A', date: '2025-01-10', account: '5510', amount: 2000 });
  B.recordPurchase(b, { vendor: 'B', date: '2025-01-30', account: '5510', amount: 500 }); // not on statement yet
  B.importStatement(b, [{ date: '2025-01-11', description: 'A', amount: -2000 }, { date: '2025-01-31', description: 'FEE', amount: -100 }]);
  B.autoMatch(b);
  let p = B.reconciliationPreview(b, { statementDate: '2025-01-31', closingBalance: 97900 });
  assert.equal(p.opening, 100000);
  assert.equal(p.unmatched.length, 1);
  assert.equal(p.outstanding.length, 1);
  assert.equal(p.canFinalize, false);
  assert.throws(() => B.finalizeReconciliation(b, { statementDate: '2025-01-31', closingBalance: 97900 }), /need matching/);
  B.categorizeLine(b, b.statement[1].id, { account: '5540' });
  p = B.reconciliationPreview(b, { statementDate: '2025-01-31', closingBalance: 97800 });
  assert.equal(p.difference, -100);
  assert.throws(() => B.finalizeReconciliation(b, { statementDate: '2025-01-31', closingBalance: 97800 }), /Out of balance/);
  const rec = B.finalizeReconciliation(b, { statementDate: '2025-01-31', closingBalance: 97900 });
  assert.equal(rec.lineIds.length, 2);
  assert.throws(() => B.unmatchLine(b, b.statement[0].id), /finalised/);
  assert.throws(() => B.reconciliationPreview(b, { statementDate: '2025-01-15', closingBalance: 0 }), /after the last/);
  assert.equal(B.reconciliationPreview(b, { statementDate: '2025-02-28', closingBalance: 97900 }).opening, 97900);
});

test('lock date blocks postings in closed years', () => {
  const b = fresh(); const c = client(b);
  B.lockBooks(b, '2025-12-31');
  assert.throws(() => B.createInvoice(b, { customerId: c.id, date: '2025-12-31', items: [{ description: 'x', qty: '1', unitPrice: '1' }] }), /locked/);
  assert.equal(b.invoices.length, 0);
  B.createInvoice(b, { customerId: c.id, date: '2026-01-01', items: [{ description: 'x', qty: '1', unitPrice: '1' }] });
});

test('VAT watch: €42,500 services threshold on current and previous calendar year', () => {
  const b = fresh(); const c = client(b);
  const inv = amt => B.createInvoice(b, { customerId: c.id, date: '2025-06-01', items: [{ description: 'x', qty: '1', unitPrice: amt }] });
  inv('30000');
  assert.equal(B.vatWatch(b, '2025-07-01').status, 'ok');
  inv('5000');
  assert.equal(B.vatWatch(b, '2025-07-01').status, 'warning');
  inv('7501');
  assert.equal(B.vatWatch(b, '2025-07-01').status, 'exceeded');
  assert.equal(B.vatWatch(b, '2026-02-01').status, 'exceeded', 'previous year over threshold still counts');
  assert.equal(B.vatWatch(b, '2027-02-01').status, 'ok');
});

test('full year → Form 11 extracts, balance sheet ties to capital', () => {
  const b = fresh(); const c = client(b);
  const i1 = B.createInvoice(b, { customerId: c.id, date: '2025-02-01', items: [{ description: 'Fees', qty: '1', unitPrice: '30000' }] });
  B.createInvoice(b, { customerId: c.id, date: '2025-12-01', items: [{ description: 'Fees', qty: '1', unitPrice: '2000.40' }] });
  B.recordInvoicePayment(b, i1.id, { date: '2025-03-01', amount: 3000000 });
  B.recordPurchase(b, { vendor: 'Dell', date: '2025-04-01', account: '1500', amount: 160000, description: 'Laptop' });
  B.recordPurchase(b, { vendor: 'Irish Rail', date: '2025-05-01', account: '5210', amount: 12000 });
  B.recordPurchase(b, { vendor: 'Circle K', date: '2025-05-02', account: '5200', amount: 30000 });
  B.recordPurchase(b, { vendor: 'Accountant', date: '2025-06-01', account: '5100', amount: 50000 });
  B.recordPurchase(b, { vendor: 'Eir', date: '2025-06-01', account: '5410', amount: 60000 });
  B.recordPurchase(b, { vendor: 'Restaurant', date: '2025-06-02', account: '5900', amount: 8000 });
  B.recordPurchase(b, { vendor: 'CTA', date: '2025-12-15', dueDate: '2026-01-15', account: '5150', amount: 35000, paid: false });
  B.importStatement(b, [{ date: '2025-07-01', description: 'ATM', amount: -500000 }, { date: '2025-08-01', description: 'Savings in', amount: 200000 }]);
  B.categorizeLine(b, b.statement[0].id, { account: '3100' }); // drawings
  B.categorizeLine(b, b.statement[1].id, { account: '3000' }); // capital introduced
  const ca = B.capitalAllowances(b, { to: '2025-12-31' });
  assert.equal(ca.total, 20000, '12.5% of €1,600 laptop = €200');
  B.postDepreciation(b, { date: '2025-12-31', amount: 40000 });

  const f = B.form11Extracts(b, { from: '2025-01-01', to: '2025-12-31' });
  const L = f.lines;
  assert.equal(L['128'], 3200040);
  assert.equal(L['132'], 3200040);
  assert.equal(L['137'], 50000);
  assert.equal(L['138'], 42000, 'motor + travel aggregated into line 138');
  assert.equal(L['141'], 40000);
  assert.equal(L['143'], 60000 + 8000 + 35000);
  const profit = 3200040 - 50000 - 42000 - 40000 - 103000;
  assert.equal(L['157'], profit);
  assert.equal(L['145'], 200000);
  assert.equal(L['146'], 500000);
  assert.equal(L['149'], 200040, 'unpaid December invoice is a debtor');
  assert.equal(L['154'], 35000, 'unpaid CTA bill is a creditor');
  assert.equal(L['150'], 100000 + 3000000 - 160000 - 12000 - 30000 - 50000 - 60000 - 8000 - 500000 + 200000);
  assert.equal(L['147a'], L['156a']);
  assert.equal(f.checks.capitalEqualsNetAssets, true);
  assert.equal(f.adjustments['161'].amount, 8000);
  assert.equal(f.adjustments['167'].amount, 40000);
  assert.equal(f.rows.find(r => r.line === '128').euro, 32000);
  const bs = B.balanceSheet(b, '2025-12-31');
  assert.equal(bs.balanced, true);
  assert.equal(bs.totalEquity, L['147a']);
  const pl = B.profitAndLoss(b, { from: '2025-01-01', to: '2025-12-31' });
  assert.equal(pl.netProfit, profit);

  const chk = B.yearEndChecklist(b, { from: '2025-01-01', to: '2025-12-31' });
  assert.equal(chk.debtors.length, 1);
  assert.equal(chk.creditors.length, 1);
  assert.equal(chk.items.find(i => /Depreciation/.test(i.label)).ok, true);
});

test('Form 11: loss year goes to line 158; credit expense balance goes to 144', () => {
  const b = fresh(); const c = client(b);
  B.createInvoice(b, { customerId: c.id, date: '2025-02-01', items: [{ description: 'F', qty: '1', unitPrice: '100' }] });
  B.recordPurchase(b, { vendor: 'X', date: '2025-02-01', account: '5510', amount: 50000 });
  B.importStatement(b, [{ date: '2025-03-01', description: 'refund', amount: 1000 }]);
  B.categorizeLine(b, b.statement[0].id, { account: '5500' }); // refund into an expense account with no other spend
  const f = B.form11Extracts(b, { from: '2025-01-01', to: '2025-12-31' });
  assert.equal(f.lines['157'], undefined);
  assert.equal(f.lines['158'], 50000 - 10000 - 1000);
  assert.equal(f.lines['144'], 1000);
});

test('save → load round trip; tampering detected', () => {
  const b = fresh(); const c = client(b);
  B.createInvoice(b, { customerId: c.id, date: '2025-02-01', items: [{ description: 'F', qty: '1', unitPrice: '100' }] });
  B.lockBooks(b, '2025-01-31');
  const data = B.serialize(b);
  const b2 = B.loadBooks(data);
  assert.deepEqual(B.form11Extracts(b2, { from: '2025-01-01', to: '2025-12-31' }).lines, B.form11Extracts(b, { from: '2025-01-01', to: '2025-12-31' }).lines);
  assert.equal(b2.ledger.lockDate, '2025-01-31');
  const bad = B.serialize(b); bad.invoices[0].journalNo = 999;
  assert.throws(() => B.loadBooks(bad), /missing journal/);
  const bad2 = B.serialize(b); bad2.ledger.entries[1].lines[0].debit += 1;
  assert.throws(() => B.loadBooks(bad2), /unbalanced/);
});

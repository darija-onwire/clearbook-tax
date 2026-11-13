import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as B from '../src/books.js';
import { parseCsv, parseXlsx, decodeText, readSpreadsheet } from '../src/sheet.js';

const fixture = n => readFileSync(new URL(`./fixtures/${n}`, import.meta.url));
const importRows = (b, rows, opts) => {
  const recs = B.prepareCustomerImport(b, rows, B.detectCustomerColumns(rows[0]), opts);
  return { recs, result: B.applyCustomerImport(b, recs) };
};

test('CSV parser: quotes, embedded commas and line breaks, semicolons, tabs', () => {
  assert.deepEqual(parseCsv('Name,Address\n"Kelly, Mary","1 Main St\nCork"\n'), [['Name', 'Address'], ['Kelly, Mary', '1 Main St\nCork']]);
  assert.deepEqual(parseCsv('a;b\r\n1;"x ""y"""\r\n'), [['a', 'b'], ['1', 'x "y"']]);
  assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
  assert.throws(() => parseCsv('a\n"open'), /unclosed/);
});

test('decodeText: UTF-8 with BOM and Windows-1252 (Excel CSV) both keep fadas', () => {
  assert.equal(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('Seán')])), 'Seán');
  assert.equal(decodeText(new Uint8Array([0x53, 0x65, 0xe1, 0x6e, 0x20, 0x80])), 'Seán €');
});

test('XLSX reader: first sheet, shared strings, numbers, booleans, gaps, line breaks', async () => {
  const rows = await parseXlsx(fixture('customers.xlsx'));
  assert.equal(rows[0][0], 'Customer Name');
  assert.equal(rows[1][0], 'Ó Briain Plumbing Ltd');
  assert.equal(rows[1][3], '871234567');
  assert.equal(rows[2][4], '12 Main Street\nApartment 2');
  assert.equal(rows[6][3], 'TRUE');
  assert.equal(rows[6][9], '<VIP> & "special"');
  assert.equal(rows.length, 7);
  await assert.rejects(readSpreadsheet('old.xls', new Uint8Array(4)), /Save As/);
  await assert.rejects(parseXlsx(new Uint8Array(100)), /valid \.xlsx/);
});

test('column detection by header names', () => {
  assert.deepEqual(B.detectCustomerColumns(['Customer Name', 'E-mail', 'Address Line 1', 'Town', 'Post code', 'PPSN', 'Random']),
    ['name', 'email', 'address', 'address', 'eircode', 'taxRef', '']);
  assert.deepEqual(B.detectCustomerColumns(['First name', 'Surname']), ['firstName', 'lastName']);
});

test('full Excel import: statuses, validation, normalisation, phone fix, duplicates', async () => {
  const b = B.createBooks();
  B.addCustomer(b, { name: 'Café Nua', email: 'old@cafenua.ie' });
  const rows = await parseXlsx(fixture('customers.xlsx'));
  const cols = B.detectCustomerColumns(rows[0]);
  const recs = B.prepareCustomerImport(b, rows, cols);
  assert.deepEqual(recs.map(r => [r.rowNo, r.status]), [[2, 'new'], [3, 'new'], [5, 'error'], [6, 'duplicate'], [7, 'skip-existing']]);
  const ob = recs[0].data;
  assert.equal(ob.email, 'sean@obriain.ie');
  assert.equal(ob.phone, '0871234567');
  assert.match(recs[0].warnings.join(), /leading 0/);
  assert.equal(ob.address, 'Unit 4, Kinsale Road\nCork\nCo. Cork');
  assert.equal(ob.eircode, 'T12 XY34');
  assert.equal(ob.taxRef, '1234567T');
  assert.equal(ob.contactName, 'Seán Ó Briain');
  assert.match(recs[2].error, /Invalid email/);
  assert.equal(b.customers.length, 1, 'prepare does not change the books');
  const res = B.applyCustomerImport(b, recs);
  assert.deepEqual(res, { added: 2, updated: 0, skipped: 3 });
  assert.equal(b.customers.find(c => c.name === 'Café Nua').email, 'old@cafenua.ie');
  const cafe = recs.find(r => r.data.name === 'Café Nua');
  assert.equal(cafe.data.phone, '', 'boolean TRUE in phone column is dropped');
  assert.match(cafe.warnings.join(), /not a phone number/);
});

test('update mode overwrites only non-empty fields of existing customers', () => {
  const b = B.createBooks();
  B.addCustomer(b, { name: 'Kelly Ltd', email: 'a@kelly.ie', phone: '01 555 0000', notes: 'keep me' });
  const rows = [['Name', 'Email', 'Phone', 'Notes'], ['KELLY LTD', 'new@kelly.ie', '', '']];
  const { result } = importRows(b, rows, { onExisting: 'update' });
  assert.deepEqual(result, { added: 0, updated: 1, skipped: 0 });
  const c = b.customers[0];
  assert.equal(c.name, 'Kelly Ltd', 'name match is case-insensitive and the original name is kept');
  assert.deepEqual([c.email, c.phone, c.notes], ['new@kelly.ie', '01 555 0000', 'keep me']);
});

test('first + last name build the customer name when there is no name column', async () => {
  const b = B.createBooks();
  const rows = await parseXlsx(fixture('people.xlsx'));
  importRows(b, rows);
  assert.equal(b.customers[0].name, 'Mary Kelly');
  assert.equal(b.customers[0].phone, '0861112222');
});

test('import validation: no name column, too long, header only', () => {
  const b = B.createBooks();
  assert.throws(() => B.prepareCustomerImport(b, [['Email'], ['x@y.ie']], ['email']), /name/);
  assert.throws(() => B.prepareCustomerImport(b, [['Name']], ['name']), /at least one/);
  const recs = B.prepareCustomerImport(b, [['Name'], ['x'.repeat(201)]], ['name']);
  assert.match(recs[0].error, /too long/);
});

test('customer edits: validation and duplicate names', () => {
  const b = B.createBooks();
  const a = B.addCustomer(b, { name: 'A Ltd', eircode: 'd02x285' });
  assert.equal(a.eircode, 'D02 X285');
  B.addCustomer(b, { name: 'B Ltd' });
  assert.throws(() => B.updateCustomer(b, a.id, { name: 'b ltd' }), /already exists/);
  assert.throws(() => B.updateCustomer(b, a.id, { email: 'bad' }), /Invalid email/);
  assert.throws(() => B.updateCustomer(b, a.id, { phone: 'call me' }), /Invalid phone/);
  B.updateCustomer(b, a.id, { phone: '+353 (0)1 555-0101 ext 22' });
  assert.throws(() => B.addCustomer(b, { name: '  ' }), /required/);
  B.updateCustomer(b, a.id, { phone: '087 000 0000' });
  assert.equal(a.name, 'A Ltd');
});

test('invoice snapshot includes eircode and contact; export round-trips', () => {
  const b = B.createBooks();
  const c = B.addCustomer(b, { name: 'A Ltd', contactName: 'Áine', address: '1 Main St\nCork', eircode: 'T12XY34' });
  const inv = B.createInvoice(b, { customerId: c.id, date: '2025-03-01', items: [{ description: 'x', qty: '1', unitPrice: '10' }] });
  assert.equal(inv.customerSnapshot.address, '1 Main St\nCork\nT12 XY34');
  assert.equal(inv.customerSnapshot.contactName, 'Áine');
  const rows = B.customersToRows(b);
  const b2 = B.createBooks();
  importRows(b2, rows);
  const { id: _a, ...x } = b.customers[0]; const { id: _b, ...y } = b2.customers[0];
  assert.deepEqual(y, x);
});

test('delete customer only when never invoiced', () => {
  const b = B.createBooks();
  const a = B.addCustomer(b, { name: 'A' }), c = B.addCustomer(b, { name: 'C' });
  B.createInvoice(b, { customerId: a.id, date: '2025-03-01', items: [{ description: 'x', qty: '1', unitPrice: '1' }] });
  assert.throws(() => B.deleteCustomer(b, a.id), /has invoices/);
  B.deleteCustomer(b, c.id);
  assert.deepEqual(b.customers.map(x => x.name), ['A']);
});

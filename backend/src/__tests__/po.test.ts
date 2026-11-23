import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPoCandidates, looksLikePo, isLabelledPo } from '../services/poResolver';
import { toUsDate, supplierSimilarity } from '../services/apInvoice';

const vals = (t: string, inv?: string) => findPoCandidates(t, { invoiceNum: inv }).map((c) => `${c.strength}:${c.value}`);

test('PO finder: table layout gives the PO column value, not customer id, rental no, invoice no or "Polymers"', () => {
  assert.deepEqual(vals('Customer ID | PO# | Rental # | Pay Online ID | Clerk | Terms\nC173 | 380807 | 55 | x | y | NET 30\nInvoice No. 14591\nAcme Polymers LLC', '14591'), ['strong:380807']);
  assert.deepEqual(vals('Customer ID  PO#  Rental #  Pay Online ID  Clerk  Terms\nC173  380807  14  abc  JD  NET30'), ['strong:380807']);
});
test('PO finder: inline, next-line and punctuation variants', () => {
  assert.deepEqual(vals('PO# 372837'), ['strong:372837']);
  assert.deepEqual(vals('P.O. No. 44-5521 ship via'), ['strong:44-5521']);
  assert.deepEqual(vals('Purchase Order:\n4500123\nShip Via UPS'), ['strong:4500123']);
  assert.deepEqual(vals('Your PO Number 5512\nPO Date 12/22/2025'), ['strong:5512']);
  assert.deepEqual(vals('PO#380807'), ['strong:380807']);
});
test('PO finder: flattened PDF text-layer table is a medium (Oracle-confirmable) hint, terms are never picked', () => {
  assert.deepEqual(vals('Customer ID PO# Rental # Terms\nC173 380807 14 NET30'), ['medium:380807']);
});
test('PO finder: sales/vendor order numbers, dates, terms and invoice numbers are not POs', () => {
  assert.deepEqual(vals('Sales Order No. 99881\nOur Order # 44556\nWork Order 12345'), []);
  assert.deepEqual(vals('Order No. 7712345\nInvoice Number 5000'), ['medium:7712345']);
  assert.deepEqual(vals('Invoice 14591\nPO 14591', '14591'), []);
  assert.deepEqual(vals('Your PO 12/22/2025\nRef PO: ABC'), []);
  assert.equal(looksLikePo('Polymers'), false); assert.equal(looksLikePo('NET30'), false); assert.equal(looksLikePo('123'), false); assert.equal(looksLikePo('4500123'), true);
});
test('PO finder: verification of a model-provided PO', () => {
  assert.equal(isLabelledPo('372837', 'Invoice 1\nPO# 372837'), true);
  assert.equal(isLabelledPo('14591', 'Invoice No. 14591\nPO# 372837', '14591'), false);
  assert.equal(isLabelledPo('777', 'Shipper number 777'), false);
});
test('dates: common printed formats become MM/DD/YYYY', () => {
  const d = (s: string) => toUsDate(s).value;
  assert.equal(d('12/22/2025'), '12/22/2025'); assert.equal(d('2025-12-22'), '12/22/2025'); assert.equal(d('1/5/25'), '01/05/2025');
  assert.equal(d('Dec 22, 2025'), '12/22/2025'); assert.equal(d('22 December 2025'), '12/22/2025'); assert.equal(d('22-Dec-25'), '12/22/2025');
  assert.equal(d('22/12/2025'), '12/22/2025'); assert.equal(toUsDate('22/12/2025').swapped, true);
  assert.equal(d('31/31/2025'), null); assert.equal(d('not a date'), null); assert.equal(d(''), null);
});
test('supplier similarity ignores legal suffixes and case', () => {
  assert.equal(supplierSimilarity('Brady Worldwide Inc', 'BRADY WORLDWIDE'), 1);
  assert.ok(supplierSimilarity('Uline, Inc.', 'ULINE') >= 0.99);
  assert.ok(supplierSimilarity('Brady Worldwide', 'Totally Other Vendor') < 0.5);
  assert.equal(supplierSimilarity('', 'x'), 1);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliveryReceiptHtml, receiptTotals } from './deliveryReceipt.js';

const receipt = {
  request_number: 'FT-20261111-ABC123', branch: 'Herald Branch 1 - Las Piñas', city: 'Las Piñas', brand: 'Kkopi', address: 'Alabang–Zapote Road', contact: '09171110001',
  requested_on: '2026-11-11T01:00:00Z', delivery_date: '2026-11-13', urgency: 'critical', remarks: 'Back door <gate>',
  items: [{ name: 'Coffee beans', unit: 'kg', quantity: 10 }, { name: 'Fresh milk', unit: 'l', quantity: 2.5 }, { name: 'Ground coffee', unit: 'kg', quantity: 3 }],
  driver_name: 'Juan Dela Cruz', driver_contact: '09171234567', plate_number: 'NBC 1234', departed_at: '2026-11-12T00:00:00Z', eta_at: '2026-11-12T03:00:00Z',
  signatures: ['Released by', 'Received by'], backorder_of: 'FT-20261110-XYZ',
};

test('totals per unit', () => {
  assert.equal(receiptTotals(receipt.items), '13 kg · 2.5 l');
  assert.equal(receiptTotals([]), '');
});

test('the printed receipt has every field, escapes text and does not repeat the city', () => {
  const html = deliveryReceiptHtml(receipt, new Date('2026-11-12T00:30:00Z'));
  for (const text of ['FT-20261111-ABC123', 'Juan Dela Cruz', '09171234567', 'NBC 1234', 'Kkopi', 'Alabang–Zapote Road', '09171110001', '3 items', '13 kg · 2.5 l', 'Released by', 'Received by', 'CRITICAL', 'Backorder of FT-20261110-XYZ', 'Received ✓', '@page { size: A4']) {
    assert.ok(html.includes(text), text);
  }
  assert.ok(html.includes('Back door &lt;gate&gt;'), 'remarks are escaped');
  assert.ok(!html.includes('Las Piñas, Las Piñas'), 'no repeated city');
  assert.ok(html.includes('@media print { body { margin: 0; } .bar { display: none; } }'), 'the Print and Close bar is not printed');
});

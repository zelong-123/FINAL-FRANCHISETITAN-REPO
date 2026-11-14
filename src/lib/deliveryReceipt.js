// The printable Delivery Receipt Logistics hands over with a dispatch. Plain HTML in a new window,
// printed by the browser (A4); the data comes from GET /supply-requests/:id/delivery-receipt.

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (value) => (value ? new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—');
const day = (value) => (value ? new Intl.DateTimeFormat('en-PH', { timeZone: 'UTC', dateStyle: 'medium' }).format(new Date(`${String(value).slice(0, 10)}T00:00:00Z`)) : '—');
const amount = (n) => Number(n).toLocaleString('en-PH', { maximumFractionDigits: 2 });

/** Totals per unit, e.g. "13 kg · 200 pcs". */
export function receiptTotals(items = []) {
  const byUnit = new Map();
  for (const item of items) byUnit.set(item.unit || '', (byUnit.get(item.unit || '') || 0) + Number(item.quantity || 0));
  return [...byUnit].map(([unit, total]) => `${amount(total)} ${unit}`.trim()).join(' · ');
}

export function deliveryReceiptHtml(r, printedAt = new Date()) {
  const items = r.items || [];
  const rows = items.map((i, n) => `<tr><td class="n">${n + 1}</td><td>${escape(i.name)}</td><td class="q">${escape(amount(i.quantity))}</td><td>${escape(i.unit)}</td><td class="box"></td></tr>`).join('');
  const urgent = r.urgency && r.urgency !== 'normal' ? `<span class="tag">${escape(r.urgency.toUpperCase())}</span>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Delivery Receipt ${escape(r.request_number)}</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font: 12.5px/1.45 system-ui, "Segoe UI", Arial, sans-serif; color: #111; margin: 24px; }
  .bar { display: flex; gap: 8px; justify-content: flex-end; margin-bottom: 14px; }
  .bar button { font: inherit; padding: 7px 14px; border: 1px solid #888; border-radius: 8px; background: #f4f4f4; cursor: pointer; }
  .top { display: flex; justify-content: space-between; align-items: flex-end; gap: 20px; border-bottom: 2px solid #111; padding-bottom: 8px; }
  h1 { font-size: 20px; margin: 0; letter-spacing: -.01em; }
  .muted { color: #555; }
  .num { font: 700 15px ui-monospace, Consolas, monospace; text-align: right; }
  .tag { display: inline-block; margin-left: 6px; padding: 1px 7px; border: 1.5px solid #111; border-radius: 4px; font: 700 10.5px system-ui; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 28px; margin: 12px 0 14px; }
  .grid div { display: flex; gap: 8px; } .grid b { min-width: 104px; color: #333; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #999; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #eee; font-size: 11.5px; }
  .n { width: 32px; text-align: center; } .q { text-align: right; width: 90px; } .box { width: 84px; }
  tfoot td { font-weight: 700; background: #fafafa; }
  .note { margin: 10px 0 0; padding: 8px 10px; border: 1px dashed #999; border-radius: 6px; }
  .sign { display: grid; grid-template-columns: 1fr 1fr; gap: 36px; margin-top: 40px; page-break-inside: avoid; }
  .sign div { border-top: 1px solid #111; padding-top: 5px; }
  .sign small { display: block; color: #555; margin-top: 18px; border-top: 1px dotted #999; padding-top: 3px; }
  footer { margin-top: 22px; font-size: 10.5px; color: #555; display: flex; justify-content: space-between; gap: 12px; }
  tr { page-break-inside: avoid; }
  @media print { body { margin: 0; } .bar { display: none; } }
</style></head><body>
<div class="bar"><button type="button" onclick="window.print()">Print</button><button type="button" onclick="window.close()">Close</button></div>
<div class="top">
  <div><h1>Delivery Receipt${urgent}</h1><div class="muted">Franchise Titan · Central Warehouse</div></div>
  <div><div class="num">${escape(r.request_number)}</div>${r.backorder_of ? `<div class="muted">Backorder of ${escape(r.backorder_of)}</div>` : ''}</div>
</div>
<div class="grid">
  <div><b>Branch</b><span>${escape(r.branch)}${r.city && !String(r.branch || '').toLowerCase().includes(String(r.city).toLowerCase()) ? `, ${escape(r.city)}` : ''}</span></div>
  <div><b>Brand</b><span>${escape(r.brand || '—')}</span></div>
  <div><b>Address</b><span>${escape(r.address)}</span></div>
  <div><b>Contact</b><span>${escape(r.contact || '—')}</span></div>
  <div><b>Requested</b><span>${escape(when(r.requested_on))}</span></div>
  <div><b>Delivery date</b><span>${escape(day(r.delivery_date))}</span></div>
  <div><b>Driver</b><span>${escape(r.driver_name)} · ${escape(r.driver_contact)}</span></div>
  <div><b>Plate number</b><span>${escape(r.plate_number)}</span></div>
  <div><b>Departure</b><span>${escape(when(r.departed_at))}</span></div>
  <div><b>ETA</b><span>${escape(when(r.eta_at))}</span></div>
</div>
<table>
  <thead><tr><th class="n">#</th><th>Item</th><th class="q">Quantity</th><th>Unit</th><th class="box">Received ✓</th></tr></thead>
  <tbody>${rows}</tbody>
  <tfoot><tr><td colspan="2">${items.length} item${items.length === 1 ? '' : 's'}</td><td colspan="3">${escape(receiptTotals(items))}</td></tr></tfoot>
</table>
${r.remarks ? `<p class="note"><b>Remarks:</b> ${escape(r.remarks)}</p>` : ''}
<p class="note">Branch: count the items on arrival. Write damaged or missing items here, then confirm the receipt in the branch portal (good, damaged and short per item, with a photo of damaged items).</p>
<div class="sign">
  ${(r.signatures || ['Released by', 'Received by']).map((s, i) => `<div><b>${escape(s)}</b> <span class="muted">(${i === 0 ? 'Logistics' : 'Branch'})</span><small>Name and signature</small><small>Date and time</small></div>`).join('')}
</div>
<footer><span>Printed ${escape(when(printedAt))}</span><span>${escape(r.request_number)}</span></footer>
</body></html>`;
}

/**
 * Opens a window at once (inside the click, so it is not blocked as a pop-up), then loads the
 * receipt into it and asks the browser to print. Returns false when pop-ups are blocked.
 */
export async function printDeliveryReceipt(load) {
  const win = window.open('', '_blank', 'width=860,height=960');
  if (!win) return false;
  win.document.write('<p style="font:14px system-ui;margin:28px">Preparing the Delivery Receipt…</p>');
  try {
    const receipt = await load();
    win.document.open();
    win.document.write(deliveryReceiptHtml(receipt));
    win.document.close();
    win.focus();
    win.setTimeout(() => win.print(), 300);
    return true;
  } catch (error) {
    win.close();
    throw error;
  }
}

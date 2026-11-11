// The printable Delivery Receipt Logistics hands over with a dispatch. Plain HTML in a new window,
// printed by the browser; the data comes from GET /supply-requests/:id/delivery-receipt.

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (value) => (value ? new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—');

export function deliveryReceiptHtml(r) {
  const rows = (r.items || []).map((i, n) => `<tr><td>${n + 1}</td><td>${escape(i.name)}</td><td class="q">${escape(i.quantity)}</td><td>${escape(i.unit)}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Delivery Receipt ${escape(r.request_number)}</title>
<style>
  body{font:13px/1.45 system-ui,Segoe UI,Arial,sans-serif;color:#111;margin:28px}
  h1{font-size:20px;margin:0}.muted{color:#555}.top{display:flex;justify-content:space-between;gap:20px;border-bottom:2px solid #111;padding-bottom:10px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 24px;margin:16px 0}.grid b{display:inline-block;min-width:110px}
  table{width:100%;border-collapse:collapse;margin-top:8px}th,td{border:1px solid #999;padding:6px 8px;text-align:left}th{background:#eee}.q{text-align:right}
  .sign{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:56px}.sign div{border-top:1px solid #111;padding-top:6px}
  @media print{body{margin:12mm}}
</style></head><body>
<div class="top"><div><h1>Delivery Receipt</h1><div class="muted">Franchise Titan · Central Warehouse</div></div><div><b>${escape(r.request_number)}</b></div></div>
<div class="grid">
  <div><b>Branch</b>${escape(r.branch)}${r.city ? `, ${escape(r.city)}` : ''}</div><div><b>Brand</b>${escape(r.brand || '—')}</div>
  <div><b>Address</b>${escape(r.address)}</div><div><b>Contact</b>${escape(r.contact || '—')}</div>
  <div><b>Driver</b>${escape(r.driver_name)} (${escape(r.driver_contact)})</div><div><b>Plate number</b>${escape(r.plate_number)}</div>
  <div><b>Departure</b>${escape(when(r.departed_at))}</div><div><b>ETA</b>${escape(when(r.eta_at))}</div>
</div>
<table><thead><tr><th>#</th><th>Item</th><th class="q">Quantity</th><th>Unit</th></tr></thead><tbody>${rows}</tbody></table>
<div class="sign">${(r.signatures || ['Released by', 'Received by']).map((s) => `<div>${escape(s)}<br><span class="muted">Name, signature and date</span></div>`).join('')}</div>
</body></html>`;
}

/**
 * Opens a window at once (inside the click, so it is not blocked as a pop-up), then loads the
 * receipt into it and asks the browser to print. Returns false when pop-ups are blocked.
 */
export async function printDeliveryReceipt(load) {
  const win = window.open('', '_blank', 'width=820,height=900');
  if (!win) return false;
  win.document.write('<p style="font:14px system-ui;margin:28px">Preparing the Delivery Receipt…</p>');
  try {
    const receipt = await load();
    win.document.open();
    win.document.write(deliveryReceiptHtml(receipt));
    win.document.close();
    win.focus();
    win.setTimeout(() => win.print(), 250);
    return true;
  } catch (error) {
    win.close();
    throw error;
  }
}

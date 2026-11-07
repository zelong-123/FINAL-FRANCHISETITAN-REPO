import React, { useEffect, useState } from 'react';
import { FaChartLine } from 'react-icons/fa6';
import { api } from '../../lib/api';
import { formatNumber } from '../../lib/format';

/**
 * Read-only "estimated need" hint for a supply request line.
 *
 * It only displays the usage-based suggestion: it never fills, changes or
 * submits the requested quantity. Products with no linked raw material show
 * nothing at all.
 */
const cache = new Map();
const TTL_MS = 60_000;

function load(locationId, productId) {
  const key = `${locationId}:${productId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  const promise = api
    .get('/estimated-requirement/suggestion', { location_id: locationId, product_id: productId })
    .then((response) => response?.data ?? null)
    .catch(() => null); // 404 (nothing linked) or 403 → no hint
  cache.set(key, { at: Date.now(), promise });
  return promise;
}

export default function EstimateHint({ locationId, productId }) {
  const [state, setState] = useState({ key: '', data: null });
  const key = locationId && productId ? `${locationId}:${productId}` : '';

  useEffect(() => {
    if (!key) return undefined;
    let alive = true;
    load(locationId, productId).then((data) => {
      if (alive) setState({ key, data });
    });
    return () => { alive = false; };
  }, [key, locationId, productId]);

  const data = state.key === key ? state.data : null;
  if (!key || !data) return null;

  const unit = data.unit || '';
  const counted = (data.materials || []).filter((row) => row.counted);
  const needed = Math.max(0, ...counted.map((row) => Number(row.needed_weeks || 0)));
  const onOrder = counted.reduce((sum, row) => sum + Number(row.on_order || 0), 0);

  let text;
  if (counted.length === 0) {
    text = 'No estimate: the linked raw material uses a different unit.';
  } else if (data.suggested_quantity === null || data.suggested_quantity === undefined) {
    text = `Not enough usage history yet${needed > 0 ? ` (${needed} more week${needed === 1 ? '' : 's'} needed)` : ''}.`;
  } else if (Number(data.suggested_quantity) <= 0) {
    text = `Estimated need for 1 week is already covered${onOrder > 0 ? ` (incl. ${formatNumber(onOrder)} ${unit} on order)` : ''}.`;
  } else {
    text = `Suggested: ${formatNumber(data.suggested_quantity)} ${unit} for 1 week${onOrder > 0 ? `, after ${formatNumber(onOrder)} ${unit} already on order` : ''}.`;
  }

  return (
    <small className="col-span-full basis-[100%] flex flex-wrap items-center gap-[6px] -mt-[2px] text-muted text-[11.5px] leading-[1.4] [&_svg]:text-accent-text [&_svg]:flex-none" role="note" title="Estimates are based on past usage to support decisions. They are not guarantees.">
      <FaChartLine aria-hidden="true" /> {text} <span className="p-[1px_7px] rounded-[999px] border border-line-strong [background:var(--surface-subtle)] text-text-secondary text-[10.5px] font-[600]">Estimate only — not filled in</span>
    </small>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, firstValidationMessage } from '../../lib/api';
import { EmptyState, Field, LoadingState, Modal, Notice } from '../ApiUi';
import { formatDate, formatNumber } from '../../lib/format';
import useCosting from '../../lib/useCosting';

const newKey = () => globalThis.crypto?.randomUUID?.() || `prod-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const money = (value) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'PHP' }).format(Number(value || 0));

/**
 * Production: pick a published brand product and a quantity. Every ingredient is
 * checked against this branch's raw materials first; on success the deduction and
 * the finished goods happen in one transaction on the server.
 */
export default function BranchProductionPanel({ branchQuery = {}, preview = false, onGoToSupply }) {
  const costing = useCosting();
  const [data, setData] = useState(null);
  const [today, setToday] = useState([]);
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [productResponse, todayResponse] = await Promise.all([
        api.get('/branch/workspace/products', branchQuery),
        api.get('/branch/workspace/recent-production', { ...branchQuery, today: 1 }),
      ]);
      setData(productResponse.data);
      setToday(todayResponse.data || []);
      setError('');
    } catch (caught) {
      setError(firstValidationMessage(caught));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [branchQuery]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [load]);

  const products = useMemo(() => data?.products || [], [data]);
  const brandName = data?.brand?.name || 'this brand';
  const hasMaterials = Boolean(data?.has_materials);
  const selected = useMemo(
    () => products.find((product) => Number(product.id) === Number(productId)) || null,
    [products, productId],
  );

  const pieces = Number(quantity);
  const requirements = useMemo(() => {
    if (!selected || !Number.isFinite(pieces) || pieces <= 0) return [];
    return (selected.ingredients || []).map((ingredient) => {
      const needed = Number(ingredient.quantity_per_piece) * pieces;
      return {
        ...ingredient,
        needed,
        short: ingredient.missing || Number(ingredient.available) < needed,
      };
    });
  }, [selected, pieces]);

  const shortages = requirements.filter((row) => row.short);
  const canSubmit = !preview && Boolean(selected) && Number.isInteger(pieces) && pieces > 0
    && requirements.length > 0 && shortages.length === 0 && !busy;

  const submit = async (event) => {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api.post('/branch/workspace/produce-product', {
        idempotency_key: newKey(),
        items: [{ brand_product_id: Number(selected.id), quantity_pieces: Number(pieces) }],
      }, { query: branchQuery });
      setNotice(`${formatNumber(pieces)} ${selected.name} recorded. Ingredients were deducted from branch stock.`);
      setQuantity('1');
      await load(true);
    } catch (caught) {
      setError(firstValidationMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const deleteEntry = async (event) => {
    event.preventDefault();
    if (!deleteTarget) return;
    setBusy(true);
    setError('');
    try {
      await api.post(`/branch/workspace/production/${deleteTarget.id}/void`, {
        reason: reason.trim(),
        ...(branchQuery.branch_code ? { branch_code: branchQuery.branch_code } : {}),
      });
      setNotice('Production entry deleted and raw materials refunded.');
      setDeleteTarget(null);
      setReason('');
      await load(true);
    } catch (caught) {
      setError(firstValidationMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="branch-production">
      <Notice type="success">{notice}</Notice>
      <Notice type="error">{error}</Notice>

      <section className="data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65]">
        <div className="branch-panel-heading flex items-start justify-between gap-[14px] mb-[14px] [&_h2]:m-0 [&_h2]:text-text [&_h2]:text-[16px] [&_p]:m-[5px_0_0] [&_p]:text-muted [&_p]:text-[11px] [&_p]:leading-[1.6]">
          <div>
            <h2>Production today</h2>
            <p>Choose a product and the quantity made. Ingredients are deducted from this branch's raw materials in one transaction.</p>
          </div>
        </div>

        {loading && !data ? <LoadingState label="Loading products…" /> : preview ? (
          <EmptyState label="Production entry is disabled in the Admin preview." detail="Sign in as the branch franchisee to record production." />
        ) : products.length === 0 ? (
          <EmptyState
            label={`No products have been published for ${brandName} yet.`}
            detail="Admin creates products with a picture and recipe in Products, then sets them Active."
          />
        ) : !hasMaterials ? (
          <div className="branch-production-empty grid gap-3 [justify-items:start]">
            <EmptyState
              label="Products exist, but this branch has no raw materials yet."
              detail="Receive stock from a delivered supply request (Supply Request Panel) or add materials in Branch Inventory before producing."
            />
            {onGoToSupply && (
              <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]" onClick={onGoToSupply}>Open Supply Request Panel</button>
            )}
          </div>
        ) : (
          <form className="grid gap-[14px]" onSubmit={submit}>
            <div className="grid gap-[10px]">
              <Field label="Product" required>
                <select required value={productId} onChange={(event) => setProductId(event.target.value)}>
                  <option value="">Select a product</option>
                  {products.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.name} · {(product.ingredients || []).length} ingredient{(product.ingredients || []).length === 1 ? '' : 's'}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Quantity to produce" required>
                <input
                  required
                  type="number"
                  min="1"
                  step="1"
                  value={quantity}
                  onChange={(event) => setQuantity(event.target.value)}
                />
              </Field>
            </div>

            {selected && (
              <div className="[&_h3]:m-[4px_0_8px] [&_h3]:text-text [&_h3]:text-[12px]">
                <h3>Recipe breakdown for {formatNumber(pieces)} pcs</h3>
                <div className="table-wrap overflow-x-auto [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer">
                  <table>
                    <thead><tr><th>Ingredient</th><th>Per piece</th><th>Needed</th><th>Available</th><th>Status</th></tr></thead>
                    <tbody>
                      {requirements.map((row) => (
                        <tr key={row.product_id} className={row.short ? '[&_td]:text-[#f56d7d]' : ''}>
                          <td>
                            {row.name}
                            {row.missing && <small>Not in branch inventory</small>}
                          </td>
                          <td>{formatNumber(row.quantity_per_piece, 3)} {row.unit}</td>
                          <td>{formatNumber(row.needed, 3)} {row.unit}</td>
                          <td>{formatNumber(row.available, 3)} {row.unit}</td>
                          <td>{row.short ? 'Short' : 'OK'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {shortages.length > 0 && (
              <div className="grid gap-[6px] p-[12px_14px] rounded-[12px] border border-[color:color-mix(in_srgb,_#f56d7d_36%,_var(--border))] [background:color-mix(in_srgb,_#f56d7d_8%,_transparent)] text-text-secondary text-[10px] [&_strong]:text-[#f56d7d] [&_strong]:text-[11px] [&_ul]:m-0 [&_ul]:pl-[18px] [&_small]:text-muted [&_small]:text-[9px]" role="alert">
                <strong>Production is blocked — insufficient ingredients</strong>
                <ul>
                  {shortages.map((row) => (
                    <li key={row.product_id}>
                      {row.missing
                        ? `${row.name}: not in this branch's inventory`
                        : `${row.name}: required ${formatNumber(row.needed, 3)} ${row.unit}, available ${formatNumber(row.available, 3)} ${row.unit} (short by ${formatNumber(row.needed - row.available, 3)} ${row.unit})`}
                    </li>
                  ))}
                </ul>
                <small>Receive stock or lower the quantity made, then submit again.</small>
              </div>
            )}

            {selected && shortages.length === 0 && (
              <div className="flex justify-end">
                <button type="submit" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" disabled={!canSubmit}>
                  {busy ? 'Submitting…' : 'Submit production'}
                </button>
              </div>
            )}
          </form>
        )}
      </section>

      <section className="data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65]">
        <div className="branch-panel-heading flex items-start justify-between gap-[14px] mb-[14px] [&_h2]:m-0 [&_h2]:text-text [&_h2]:text-[16px] [&_p]:m-[5px_0_0] [&_p]:text-muted [&_p]:text-[11px] [&_p]:leading-[1.6]">
          <div>
            <h2>Production recorded today</h2>
            <p>Deleting an entry refunds the raw materials it consumed.</p>
          </div>
        </div>
        {today.length === 0 ? (
          <EmptyState label="No production recorded today." detail="Submit a product above and it appears here." />
        ) : (
          <div className="table-wrap overflow-x-auto [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer">
            <table>
              <thead><tr><th>Time</th><th>Product</th><th>Quantity</th>{costing && <th>Material cost</th>}<th>Submitted by</th><th /></tr></thead>
              <tbody>
                {today.map((row) => (
                  <tr key={row.id} className={row.voided ? '[&_td]:opacity-[.6] [&_td]:[text-decoration:line-through] [&_td_small]:[text-decoration:none]' : ''}>
                    <td>{formatDate(row.date, true)}</td>
                    <td>{row.product}{row.voided && <small>Voided · {row.void_reason}</small>}</td>
                    <td>{formatNumber(row.quantity)} pcs</td>
                    {costing && <td>{money(row.material_cost)}</td>}
                    <td>{row.submitted_by}</td>
                    <td>
                      {!row.voided && (
                        <button
                          type="button"
                          className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px] small [&.ghost-button]:min-h-[32px] [&.ghost-button]:p-[0_10px] [&.ghost-button]:text-[12px]"
                          onClick={() => { setNotice(''); setError(''); setReason(''); setDeleteTarget(row); }}
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {deleteTarget && (
        <Modal
          title={`Delete ${deleteTarget.product} · ${formatNumber(deleteTarget.quantity)} pcs?`}
          onClose={() => (busy ? null : setDeleteTarget(null))}
          size="small"
          footer={(
            <>
              <button type="button" onClick={() => setDeleteTarget(null)} disabled={busy}>Cancel</button>
              <form id="delete-production-form" onSubmit={deleteEntry} style={{ display: 'contents' }}>
                <button type="submit" className="primary-button [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)] danger-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] later:[background:linear-gradient(135deg,_#ef596b,_#c9374a)] later:[box-shadow:0_12px_28px_color-mix(in_srgb,_var(--danger)_21%,_transparent)]" disabled={busy}>
                  {busy ? 'Deleting…' : 'Delete and refund materials'}
                </button>
              </form>
            </>
          )}
        >
          <p>The deducted ingredients are added back to branch raw materials and the finished quantity is removed. It is audit-logged and Admin is notified with your reason.</p>
          <Field label="Reason" hint="Required. Admin sees this reason in the notification.">
            <input required maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why is this entry deleted?" />
          </Field>
        </Modal>
      )}
    </div>
  );
}

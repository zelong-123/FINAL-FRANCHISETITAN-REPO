import { useCallback, useEffect, useRef, useState } from 'react';
import { api, firstValidationMessage } from '../../lib/api';
import {
  REQUEST_STATUSES, combineLine, findDuplicate, putLine, removeLine, toRequestItems,
} from '../../lib/branchWorkspace';
import { EmptyState, LoadingState, Notice, StatusBadge } from '../ApiUi';
import { formatDate, formatNumber } from '../../lib/format';
import { supplyStatusLabel } from '../../lib/supplyActions';
import EstimateHint from '../supply/EstimateHint';

const NO_FILTERS = { date: '', status: '' };
const NO_PICK = { product_id: '', quantity: '' };

/**
 * Supply Request Panel: build a Request List of the branch brand's warehouse
 * products, submit it once as one request, and follow it under Request Status.
 */
export default function BranchSupplyPanel({ branchQuery = {}, location = null, preview = false }) {
  const [products, setProducts] = useState([]);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [lines, setLines] = useState([]);
  const [pick, setPick] = useState(NO_PICK);
  const [editingId, setEditingId] = useState(null);
  const [duplicate, setDuplicate] = useState(null); // { line, existing } awaiting the user's answer
  const [targetDate, setTargetDate] = useState('');
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [requests, setRequests] = useState([]);
  const [filters, setFilters] = useState(NO_FILTERS);
  const [loadingRequests, setLoadingRequests] = useState(true);
  const [statusError, setStatusError] = useState('');

  // State updates only after a re-render, so a second click could still get through without this.
  const submitLock = useRef(false);
  const latestRequestsCall = useRef(0);

  useEffect(() => {
    let active = true;
    setLoadingProducts(true);
    api.get('/branch/workspace/warehouse-products', branchQuery)
      .then((response) => { if (active) setProducts(response.data?.products || []); })
      .catch((caught) => { if (active) setError(firstValidationMessage(caught)); })
      .finally(() => { if (active) setLoadingProducts(false); });
    return () => { active = false; };
  }, [branchQuery]);

  const loadRequests = useCallback(async (silent = false) => {
    const call = ++latestRequestsCall.current;
    if (!silent) setLoadingRequests(true);
    try {
      const response = await api.get('/branch/workspace/supply-requests', { ...branchQuery, ...filters });
      if (call === latestRequestsCall.current) {
        setRequests(response.data || []);
        setStatusError('');
      }
    } catch (caught) {
      if (call === latestRequestsCall.current) setStatusError(firstValidationMessage(caught));
    } finally {
      if (call === latestRequestsCall.current) setLoadingRequests(false);
    }
  }, [branchQuery, filters]);

  useEffect(() => { void loadRequests(); }, [loadRequests]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadRequests(true);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [loadRequests]);

  const resetForm = () => {
    setPick(NO_PICK);
    setEditingId(null);
    setDuplicate(null);
  };

  const addToList = (event) => {
    event.preventDefault();
    setError('');
    setNotice('');
    const product = products.find((row) => String(row.id) === String(pick.product_id));
    const quantity = Number(pick.quantity);
    if (!product) {
      setError('Choose a warehouse item to add.');
      return;
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setError('Quantity must be greater than zero.');
      return;
    }
    const line = { product_id: product.id, name: product.name, unit: product.unit, quantity };
    const existing = findDuplicate(lines, product.id, editingId);
    if (existing) {
      setDuplicate({ line, existing });
      return;
    }
    setLines((current) => putLine(current, line, editingId));
    resetForm();
  };

  const confirmCombine = () => {
    setLines((current) => combineLine(current, duplicate.line, editingId));
    resetForm();
  };

  const editLine = (line) => {
    setError('');
    setDuplicate(null);
    setEditingId(line.product_id);
    setPick({ product_id: String(line.product_id), quantity: String(line.quantity) });
  };

  const unselectLine = (line) => {
    setLines((current) => removeLine(current, line.product_id));
    if (editingId === line.product_id) resetForm();
    if (duplicate?.existing.product_id === line.product_id) setDuplicate(null);
  };

  const submit = async () => {
    if (submitLock.current || preview || !location?.id || lines.length === 0) return;
    submitLock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await api.post('/supply-requests', {
        location_id: location.id,
        target_delivery_date: targetDate || null,
        delivery_address: location.address || location.name,
        remarks: remarks.trim() || null,
        submit: true,
        items: toRequestItems(lines),
      });
      const count = lines.length;
      setLines([]);
      setTargetDate('');
      setRemarks('');
      resetForm();
      setNotice(`Request ${response.data?.request_number || ''} submitted with ${count} item${count === 1 ? '' : 's'}. Admin will review it.`);
      // Show the new request even when the current filters would have hidden it.
      if (filters.date || filters.status) setFilters(NO_FILTERS);
      else await loadRequests(true);
    } catch (caught) {
      setError(firstValidationMessage(caught));
    } finally {
      submitLock.current = false;
      setBusy(false);
    }
  };

  const filtered = Boolean(filters.date || filters.status);

  return (
    <div className="branch-supply">
      <Notice type="success">{notice}</Notice>
      <Notice type="error">{error}</Notice>

      <div className="grid gap-4 max-[761px]:later:grid-cols-[1fr] later-2:grid-cols-[minmax(0,_2fr)_minmax(0,_3fr)] later:items-stretch later:[&>.data-panel]:mb-0 max-[1181px]:later-3:grid-cols-[minmax(0,_1fr)]">
        <section className="data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65] flex flex-col p-0">
          <header className="min-h-[72px] flex flex-wrap items-center justify-between gap-3 m-[0_20px] p-[14px_8px] [border-bottom:1px_solid_color-mix(in_srgb,_var(--branch-accent)_28%,_var(--border))] [&_h2]:m-0 [&_h2]:text-text [&_h2]:text-[20px] [&_h2]:font-[800] [&_h2]:tracking-[.01em] [&_h2]:uppercase max-[761px]:later:m-[0_16px] max-[761px]:later:p-[12px_0] max-[761px]:later:min-h-0 max-[761px]:later:[&_h2]:text-[17px]"><h2>Supply Request</h2></header>
          <div className="flex-1 min-w-0 flex flex-col p-[16px_20px_20px] max-[761px]:later:p-[14px_16px_16px]">
            {loadingProducts ? <LoadingState label="Loading warehouse availability…" /> : products.length === 0 ? (
              <EmptyState label="No warehouse items are available for this brand yet." detail="Admin adds warehouse products per brand." />
            ) : (
              <div className="flex-1 flex flex-col gap-4 [&_form]:grid [&_form]:gap-3">
                <form onSubmit={addToList}>
                  <label className="branch-field [&_input]:w-full [&_input]:min-h-[42px] [&_input]:p-[8px_12px] [&_input]:border [&_input]:border-input-line [&_input]:rounded-[10px] [&_input]:text-text [&_input]:[background-color:var(--input-bg)] [&_input]:text-[14px] [&_input]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease] [&_select]:w-full [&_select]:min-h-[42px] [&_select]:p-[8px_12px] [&_select]:border [&_select]:border-input-line [&_select]:rounded-[10px] [&_select]:text-text [&_select]:[background-color:var(--input-bg)] [&_select]:text-[14px] [&_select]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease] [&_textarea]:w-full [&_textarea]:min-h-[42px] [&_textarea]:p-[8px_12px] [&_textarea]:border [&_textarea]:border-input-line [&_textarea]:rounded-[10px] [&_textarea]:text-text [&_textarea]:[background-color:var(--input-bg)] [&_textarea]:text-[14px] [&_textarea]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease] [&_select_option]:text-text [&_select_option]:[background:var(--panel)] [&_input:focus]:[outline:0] [&_input:focus]:border-[color:var(--branch-accent)] [&_input:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--branch-accent)_17%,_transparent)] [&_select:focus]:[outline:0] [&_select:focus]:border-[color:var(--branch-accent)] [&_select:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--branch-accent)_17%,_transparent)] [&_textarea:focus]:[outline:0] [&_textarea:focus]:border-[color:var(--branch-accent)] [&_textarea:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--branch-accent)_17%,_transparent)] grid gap-[6px] min-w-0 [&>span]:text-text-secondary [&>span]:text-[12px] [&>span]:font-[800] [&>span]:tracking-[.03em] [&>span]:uppercase">
                    <span>Item</span>
                    <select
                      value={pick.product_id}
                      disabled={busy}
                      onChange={(event) => { setDuplicate(null); setPick({ ...pick, product_id: event.target.value }); }}
                    >
                      <option value="">Select an item</option>
                      {products.map((product) => (
                        <option key={product.id} value={product.id}>
                          {product.name} · {formatNumber(product.available)} {product.unit} available
                        </option>
                      ))}
                    </select>
                  </label>
                  {!preview && <EstimateHint locationId={location?.id} productId={pick.product_id} />}
                  <div className="flex flex-wrap items-end gap-2 [&_.branch-field]:flex-[1_1_140px] later:[&_.ghost-button]:min-h-[42px]">
                    <label className="branch-field [&_input]:w-full [&_input]:min-h-[42px] [&_input]:p-[8px_12px] [&_input]:border [&_input]:border-input-line [&_input]:rounded-[10px] [&_input]:text-text [&_input]:[background-color:var(--input-bg)] [&_input]:text-[14px] [&_input]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease] [&_select]:w-full [&_select]:min-h-[42px] [&_select]:p-[8px_12px] [&_select]:border [&_select]:border-input-line [&_select]:rounded-[10px] [&_select]:text-text [&_select]:[background-color:var(--input-bg)] [&_select]:text-[14px] [&_select]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease] [&_textarea]:w-full [&_textarea]:min-h-[42px] [&_textarea]:p-[8px_12px] [&_textarea]:border [&_textarea]:border-input-line [&_textarea]:rounded-[10px] [&_textarea]:text-text [&_textarea]:[background-color:var(--input-bg)] [&_textarea]:text-[14px] [&_textarea]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease] [&_select_option]:text-text [&_select_option]:[background:var(--panel)] [&_input:focus]:[outline:0] [&_input:focus]:border-[color:var(--branch-accent)] [&_input:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--branch-accent)_17%,_transparent)] [&_select:focus]:[outline:0] [&_select:focus]:border-[color:var(--branch-accent)] [&_select:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--branch-accent)_17%,_transparent)] [&_textarea:focus]:[outline:0] [&_textarea:focus]:border-[color:var(--branch-accent)] [&_textarea:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--branch-accent)_17%,_transparent)] grid gap-[6px] min-w-0 [&>span]:text-text-secondary [&>span]:text-[12px] [&>span]:font-[800] [&>span]:tracking-[.03em] [&>span]:uppercase">
                      <span>Quantity</span>
                      <input
                        type="number"
                        min="0.01"
                        step="any"
                        value={pick.quantity}
                        disabled={busy}
                        onChange={(event) => { setDuplicate(null); setPick({ ...pick, quantity: event.target.value }); }}
                      />
                    </label>
                    <button type="submit" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px] small [&.ghost-button]:min-h-[32px] [&.ghost-button]:p-[0_10px] [&.ghost-button]:text-[12px]" disabled={preview || busy}>
                      {editingId === null ? 'Add to list' : 'Update item'}
                    </button>
                    {editingId !== null && <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px] small [&.ghost-button]:min-h-[32px] [&.ghost-button]:p-[0_10px] [&.ghost-button]:text-[12px]" onClick={resetForm}>Cancel</button>}
                  </div>
                </form>

                {duplicate && (
                  <div className="grid gap-[10px] p-3 rounded-[10px] text-text-secondary text-[13px] border border-[color:color-mix(in_srgb,_var(--warning)_45%,_var(--border))] [background:color-mix(in_srgb,_var(--warning)_9%,_transparent)] [&_p]:m-0 [&_strong]:text-text [&_div]:flex [&_div]:gap-2" role="alert">
                    <p>
                      <strong>{duplicate.line.name}</strong> is already in the list ({formatNumber(duplicate.existing.quantity, 2)}).
                      Combine to {formatNumber(Number(duplicate.existing.quantity) + duplicate.line.quantity, 2)}?
                    </p>
                    <div>
                      <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px] small [&.ghost-button]:min-h-[32px] [&.ghost-button]:p-[0_10px] [&.ghost-button]:text-[12px]" onClick={confirmCombine}>Combine</button>
                      <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px] small [&.ghost-button]:min-h-[32px] [&.ghost-button]:p-[0_10px] [&.ghost-button]:text-[12px]" onClick={() => setDuplicate(null)}>Cancel</button>
                    </div>
                  </div>
                )}

                <div className="branch-field [&_input]:w-full [&_input]:min-h-[42px] [&_input]:p-[8px_12px] [&_input]:border [&_input]:border-input-line [&_input]:rounded-[10px] [&_input]:text-text [&_input]:[background-color:var(--input-bg)] [&_input]:text-[14px] [&_input]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease] [&_select]:w-full [&_select]:min-h-[42px] [&_select]:p-[8px_12px] [&_select]:border [&_select]:border-input-line [&_select]:rounded-[10px] [&_select]:text-text [&_select]:[background-color:var(--input-bg)] [&_select]:text-[14px] [&_select]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease] [&_textarea]:w-full [&_textarea]:min-h-[42px] [&_textarea]:p-[8px_12px] [&_textarea]:border [&_textarea]:border-input-line [&_textarea]:rounded-[10px] [&_textarea]:text-text [&_textarea]:[background-color:var(--input-bg)] [&_textarea]:text-[14px] [&_textarea]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease] [&_select_option]:text-text [&_select_option]:[background:var(--panel)] [&_input:focus]:[outline:0] [&_input:focus]:border-[color:var(--branch-accent)] [&_input:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--branch-accent)_17%,_transparent)] [&_select:focus]:[outline:0] [&_select:focus]:border-[color:var(--branch-accent)] [&_select:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--branch-accent)_17%,_transparent)] [&_textarea:focus]:[outline:0] [&_textarea:focus]:border-[color:var(--branch-accent)] [&_textarea:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--branch-accent)_17%,_transparent)] grid gap-[6px] min-w-0 [&>span]:text-text-secondary [&>span]:text-[12px] [&>span]:font-[800] [&>span]:tracking-[.03em] [&>span]:uppercase">
                  <span>Request List</span>
                  {lines.length === 0 ? (
                    <p className="m-0 p-[24px_14px] border border-input-line rounded-[10px] text-muted [background:var(--input-bg)] text-[13px] text-center">No items yet. Choose an item and quantity, then select Add to list.</p>
                  ) : (
                    <ul className="max-h-[280px] overflow-y-auto m-0 p-[0_12px] border border-input-line rounded-[10px] [background:var(--input-bg)] [list-style:none] [&_li]:flex [&_li]:flex-wrap [&_li]:items-center [&_li]:gap-3 [&_li]:p-[11px_0] [&_li]:text-text [&_li]:text-[14px] [&_li+li]:[border-top:1px_solid_color-mix(in_srgb,_var(--branch-accent)_22%,_var(--border))] [&_li.is-editing]:pl-[10px] [&_li.is-editing]:[box-shadow:inset_3px_0_var(--branch-accent)] [&_li>span]:flex-[1_1_120px] [&_li>span]:min-w-0 [&_li>span]:[overflow-wrap:anywhere] [&_small]:text-muted [&_small]:text-[12px]">
                      {lines.map((line) => (
                        <li key={line.product_id} className={editingId === line.product_id ? 'is-editing' : ''}>
                          <span>{line.name} × {formatNumber(line.quantity, 2)} <small>{line.unit}</small></span>
                          <button type="button" className="p-[2px_0] border-0 text-accent-text [background:transparent] text-[13px] font-[700] cursor-pointer later-5:[&.is-danger]:text-danger-text [&:hover:not(:disabled)]:[text-decoration:underline] disabled:opacity-[.5] disabled:cursor-not-allowed focus-visible:[outline:2px_solid_var(--branch-accent)] focus-visible:[outline-offset:2px] focus-visible:rounded-[3px] is-danger" disabled={busy} onClick={() => unselectLine(line)}>Unselect</button>
                          <button type="button" className="p-[2px_0] border-0 text-accent-text [background:transparent] text-[13px] font-[700] cursor-pointer later-5:[&.is-danger]:text-danger-text [&:hover:not(:disabled)]:[text-decoration:underline] disabled:opacity-[.5] disabled:cursor-not-allowed focus-visible:[outline:2px_solid_var(--branch-accent)] focus-visible:[outline-offset:2px] focus-visible:rounded-[3px]" disabled={busy} onClick={() => editLine(line)}>Edit</button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <details className="[&_summary]:text-text-secondary [&_summary]:text-[13px] [&_summary]:font-[700] [&_summary]:cursor-pointer later:[&>div]:grid later:[&>div]:gap-3 [&>div]:mt-3 later:[&_textarea]:min-h-[70px]">
                  <summary>Delivery date and note (optional)</summary>
                  <div>
                    <label className="branch-field [&_input]:w-full [&_input]:min-h-[42px] [&_input]:p-[8px_12px] [&_input]:border [&_input]:border-input-line [&_input]:rounded-[10px] [&_input]:text-text [&_input]:[background-color:var(--input-bg)] [&_input]:text-[14px] [&_input]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease] [&_select]:w-full [&_select]:min-h-[42px] [&_select]:p-[8px_12px] [&_select]:border [&_select]:border-input-line [&_select]:rounded-[10px] [&_select]:text-text [&_select]:[background-color:var(--input-bg)] [&_select]:text-[14px] [&_select]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease] [&_textarea]:w-full [&_textarea]:min-h-[42px] [&_textarea]:p-[8px_12px] [&_textarea]:border [&_textarea]:border-input-line [&_textarea]:rounded-[10px] [&_textarea]:text-text [&_textarea]:[background-color:var(--input-bg)] [&_textarea]:text-[14px] [&_textarea]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease] [&_select_option]:text-text [&_select_option]:[background:var(--panel)] [&_input:focus]:[outline:0] [&_input:focus]:border-[color:var(--branch-accent)] [&_input:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--branch-accent)_17%,_transparent)] [&_select:focus]:[outline:0] [&_select:focus]:border-[color:var(--branch-accent)] [&_select:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--branch-accent)_17%,_transparent)] [&_textarea:focus]:[outline:0] [&_textarea:focus]:border-[color:var(--branch-accent)] [&_textarea:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--branch-accent)_17%,_transparent)] grid gap-[6px] min-w-0 [&>span]:text-text-secondary [&>span]:text-[12px] [&>span]:font-[800] [&>span]:tracking-[.03em] [&>span]:uppercase">
                      <span>Target delivery date</span>
                      <input type="date" min={new Date().toISOString().slice(0, 10)} value={targetDate} onChange={(event) => setTargetDate(event.target.value)} />
                    </label>
                    <label className="branch-field [&_input]:w-full [&_input]:min-h-[42px] [&_input]:p-[8px_12px] [&_input]:border [&_input]:border-input-line [&_input]:rounded-[10px] [&_input]:text-text [&_input]:[background-color:var(--input-bg)] [&_input]:text-[14px] [&_input]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease] [&_select]:w-full [&_select]:min-h-[42px] [&_select]:p-[8px_12px] [&_select]:border [&_select]:border-input-line [&_select]:rounded-[10px] [&_select]:text-text [&_select]:[background-color:var(--input-bg)] [&_select]:text-[14px] [&_select]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease] [&_textarea]:w-full [&_textarea]:min-h-[42px] [&_textarea]:p-[8px_12px] [&_textarea]:border [&_textarea]:border-input-line [&_textarea]:rounded-[10px] [&_textarea]:text-text [&_textarea]:[background-color:var(--input-bg)] [&_textarea]:text-[14px] [&_textarea]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease] [&_select_option]:text-text [&_select_option]:[background:var(--panel)] [&_input:focus]:[outline:0] [&_input:focus]:border-[color:var(--branch-accent)] [&_input:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--branch-accent)_17%,_transparent)] [&_select:focus]:[outline:0] [&_select:focus]:border-[color:var(--branch-accent)] [&_select:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--branch-accent)_17%,_transparent)] [&_textarea:focus]:[outline:0] [&_textarea:focus]:border-[color:var(--branch-accent)] [&_textarea:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--branch-accent)_17%,_transparent)] grid gap-[6px] min-w-0 [&>span]:text-text-secondary [&>span]:text-[12px] [&>span]:font-[800] [&>span]:tracking-[.03em] [&>span]:uppercase">
                      <span>Remarks</span>
                      <textarea maxLength={2000} value={remarks} onChange={(event) => setRemarks(event.target.value)} placeholder="Optional note for the warehouse" />
                    </label>
                  </div>
                </details>

                <div className="mt-auto flex justify-end later-2:[&_.primary-button]:min-h-[44px] later:[&_.primary-button]:p-[0_22px] later:[&_.primary-button]:rounded-[12px] later:[&_.primary-button]:text-[14px] later:[&_.primary-button]:font-[800]">
                  <button type="button" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" disabled={preview || busy || lines.length === 0} onClick={() => void submit()}>
                    {busy ? 'Submitting…' : 'Submit Request'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65] flex flex-col p-0">
          <header className="min-h-[72px] flex flex-wrap items-center justify-between gap-3 m-[0_20px] p-[14px_8px] [border-bottom:1px_solid_color-mix(in_srgb,_var(--branch-accent)_28%,_var(--border))] [&_h2]:m-0 [&_h2]:text-text [&_h2]:text-[20px] [&_h2]:font-[800] [&_h2]:tracking-[.01em] [&_h2]:uppercase max-[761px]:later:m-[0_16px] max-[761px]:later:p-[12px_0] max-[761px]:later:min-h-0 max-[761px]:later:[&_h2]:text-[17px]"><h2>Request Status</h2></header>
          <div className="flex-1 min-w-0 flex flex-col p-[16px_20px_20px] max-[761px]:later:p-[14px_16px_16px]">
            <Notice type="error">{statusError}</Notice>
            <div className="flex flex-wrap items-end justify-end gap-[10px] mb-[14px] later:[&_.branch-field]:flex-[0_1_190px] later-3:[&_.ghost-button]:min-h-[42px] max-[761px]:later-2:[&_.branch-field]:flex-[1_1_140px]">
              <label className="branch-field [&_input]:w-full [&_input]:min-h-[42px] [&_input]:p-[8px_12px] [&_input]:border [&_input]:border-input-line [&_input]:rounded-[10px] [&_input]:text-text [&_input]:[background-color:var(--input-bg)] [&_input]:text-[14px] [&_input]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease] [&_select]:w-full [&_select]:min-h-[42px] [&_select]:p-[8px_12px] [&_select]:border [&_select]:border-input-line [&_select]:rounded-[10px] [&_select]:text-text [&_select]:[background-color:var(--input-bg)] [&_select]:text-[14px] [&_select]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease] [&_textarea]:w-full [&_textarea]:min-h-[42px] [&_textarea]:p-[8px_12px] [&_textarea]:border [&_textarea]:border-input-line [&_textarea]:rounded-[10px] [&_textarea]:text-text [&_textarea]:[background-color:var(--input-bg)] [&_textarea]:text-[14px] [&_textarea]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease] [&_select_option]:text-text [&_select_option]:[background:var(--panel)] [&_input:focus]:[outline:0] [&_input:focus]:border-[color:var(--branch-accent)] [&_input:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--branch-accent)_17%,_transparent)] [&_select:focus]:[outline:0] [&_select:focus]:border-[color:var(--branch-accent)] [&_select:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--branch-accent)_17%,_transparent)] [&_textarea:focus]:[outline:0] [&_textarea:focus]:border-[color:var(--branch-accent)] [&_textarea:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--branch-accent)_17%,_transparent)] grid gap-[6px] min-w-0 [&>span]:text-text-secondary [&>span]:text-[12px] [&>span]:font-[800] [&>span]:tracking-[.03em] [&>span]:uppercase">
                <span>Date requested</span>
                <input
                  type="date"
                  value={filters.date}
                  onChange={(event) => setFilters({ ...filters, date: event.target.value })}
                />
              </label>
              <label className="branch-field [&_input]:w-full [&_input]:min-h-[42px] [&_input]:p-[8px_12px] [&_input]:border [&_input]:border-input-line [&_input]:rounded-[10px] [&_input]:text-text [&_input]:[background-color:var(--input-bg)] [&_input]:text-[14px] [&_input]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease] [&_select]:w-full [&_select]:min-h-[42px] [&_select]:p-[8px_12px] [&_select]:border [&_select]:border-input-line [&_select]:rounded-[10px] [&_select]:text-text [&_select]:[background-color:var(--input-bg)] [&_select]:text-[14px] [&_select]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease] [&_textarea]:w-full [&_textarea]:min-h-[42px] [&_textarea]:p-[8px_12px] [&_textarea]:border [&_textarea]:border-input-line [&_textarea]:rounded-[10px] [&_textarea]:text-text [&_textarea]:[background-color:var(--input-bg)] [&_textarea]:text-[14px] [&_textarea]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease] [&_select_option]:text-text [&_select_option]:[background:var(--panel)] [&_input:focus]:[outline:0] [&_input:focus]:border-[color:var(--branch-accent)] [&_input:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--branch-accent)_17%,_transparent)] [&_select:focus]:[outline:0] [&_select:focus]:border-[color:var(--branch-accent)] [&_select:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--branch-accent)_17%,_transparent)] [&_textarea:focus]:[outline:0] [&_textarea:focus]:border-[color:var(--branch-accent)] [&_textarea:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--branch-accent)_17%,_transparent)] grid gap-[6px] min-w-0 [&>span]:text-text-secondary [&>span]:text-[12px] [&>span]:font-[800] [&>span]:tracking-[.03em] [&>span]:uppercase">
                <span>Status</span>
                <select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}>
                  <option value="">All statuses</option>
                  {REQUEST_STATUSES.map((status) => <option key={status} value={status}>{supplyStatusLabel(status)}</option>)}
                </select>
              </label>
              {filtered && <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px] small [&.ghost-button]:min-h-[32px] [&.ghost-button]:p-[0_10px] [&.ghost-button]:text-[12px]" onClick={() => setFilters(NO_FILTERS)}>Clear</button>}
            </div>

            {loadingRequests ? <LoadingState label="Loading requests…" /> : requests.length === 0 ? (
              filtered
                ? <EmptyState label="No requests match these filters." detail="Try another date or status." />
                : <EmptyState label="No supply requests for this branch yet." detail="Add items to the list and submit your first request." />
            ) : (
              <div className="table-wrap overflow-x-auto [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer">
                <table className="branch-readable-table [&_th]:text-[12px] [&_td_small]:text-[12px] [.branch-portal-page_&]:min-w-[560px] [&_td]:[vertical-align:top]">
                  <thead><tr><th>Product/Item</th><th>Date Request</th><th>Delivery Date</th><th>Status</th></tr></thead>
                  <tbody>
                    {requests.map((request) => (
                      <tr key={request.id}>
                        <td>
                          <ul className="grid gap-[6px] m-0 p-0 text-text [list-style:none] text-[14px]">
                            {(request.items || []).map((item) => (
                              <li key={item.id}>{item.product?.name || item.product_name_snapshot || 'Item'} × {formatNumber(item.quantity_requested, 2)}</li>
                            ))}
                          </ul>
                          <small>{request.request_number}</small>
                        </td>
                        <td>{formatDate(request.created_at)}</td>
                        <td>{formatDate(request.effective_delivery_date)}</td>
                        <td><StatusBadge value={request.status} label={supplyStatusLabel(request.status)} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

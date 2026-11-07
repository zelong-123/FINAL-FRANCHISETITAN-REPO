import { useCallback, useEffect, useState } from 'react';
import { api, downloadFile, firstValidationMessage } from '../../lib/api';
import { EmptyState, Field, LoadingState, Modal, Notice } from '../ApiUi';
import { formatDate, formatNumber } from '../../lib/format';
import useCosting from '../../lib/useCosting';

const money = (value) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'PHP' }).format(Number(value || 0));
const newKey = () => globalThis.crypto?.randomUUID?.() || `mat-${Date.now()}-${Math.random().toString(16).slice(2)}`;

/** Branch Inventory: raw materials with receipts, CSV import and no physical count. */
export default function BranchRawMaterialsPanel({ branchQuery = {}, preview = false }) {
  const costing = useCosting();
  const [materials, setMaterials] = useState([]);
  const [units, setUnits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [materialRows, unitRows] = await Promise.all([
        api.get('/branch/workspace/materials', branchQuery),
        api.get('/units'),
      ]);
      setMaterials(materialRows.data || []);
      setUnits(unitRows.data || []);
      setError('');
    } catch (caught) {
      setError(firstValidationMessage(caught));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [branchQuery]);

  useEffect(() => { void load(); }, [load]);

  const readOnly = preview;

  return (
    <div className="branch-raw-materials">
      <Notice type="success">{notice}</Notice>
      <Notice type="error">{error}</Notice>

      <section className="data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65]">
        <div className="branch-panel-heading flex items-start justify-between gap-[14px] mb-[14px] [&_h2]:m-0 [&_h2]:text-text [&_h2]:text-[16px] [&_p]:m-[5px_0_0] [&_p]:text-muted [&_p]:text-[11px] [&_p]:leading-[1.6]">
          <div>
            <h2>Raw materials</h2>
            <p>{costing ? 'Branch stock of ingredients and packaging, valued at weighted-average cost.' : 'Branch stock of ingredients and packaging.'}</p>
          </div>
          {!readOnly && (
            <div className="flex flex-wrap gap-2 justify-end [.branch-portal-page_&_.ghost-button]:min-h-[36px] [.branch-portal-page_&_.ghost-button]:p-[0_13px] [.branch-portal-page_&_.ghost-button]:text-[9px] [.branch-portal-page_&_.primary-button]:min-h-[36px] [.branch-portal-page_&_.primary-button]:p-[0_13px] [.branch-portal-page_&_.primary-button]:text-[9px]">
              <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]" onClick={() => { setNotice(''); setImportOpen(true); }}>
                Import Raw Materials CSV
              </button>
              <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]" onClick={() => { setNotice(''); setReceiveOpen(true); }}>
                Receive Stock
              </button>
              <button type="button" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" onClick={() => { setNotice(''); setAddOpen(true); }}>
                Add Material
              </button>
            </div>
          )}
        </div>

        {loading && !materials.length ? <LoadingState label="Loading raw materials…" /> : materials.length === 0 ? (
          <EmptyState label="No raw materials yet." detail="Add a material, receive a delivered supply request, or import a raw-materials CSV." />
        ) : (
          <div className="table-wrap overflow-x-auto [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer">
            <table>
              <thead>
                <tr>
                  <th>Material</th>
                  <th>Source</th>
                  <th>Unit</th>
                  <th>On hand</th>
                  {costing && <th>Unit cost</th>}
                  {costing && <th>Stock value</th>}
                </tr>
              </thead>
              <tbody>
                {materials.map((material) => {
                  const balance = material.balance || {};
                  const quantity = Number(balance.quantity_milli || 0) / 1000;
                  const unitCost = balance.unit_cost_micropesos == null ? null : Number(balance.unit_cost_micropesos) / 1_000_000;
                  return (
                    <tr key={material.id}>
                      <td><strong>{material.name}</strong>{material.variant ? <small>{material.variant}</small> : null}</td>
                      <td><span className="inline-flex p-[3px_8px] rounded-[999px] text-text-secondary [background:var(--surface-subtle)] border border-line text-[8.5px] font-[750]">{material.source || 'Manual'}</span></td>
                      <td>{material.unit}</td>
                      <td><strong>{formatNumber(quantity, 3)}</strong></td>
                      {costing && <td>{unitCost == null ? '—' : money(unitCost)}</td>}
                      {costing && <td>{balance.value_cents == null ? '—' : money(Number(balance.value_cents) / 100)}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {addOpen && (
        <AddMaterialModal
          branchQuery={branchQuery}
          units={units}
          onClose={() => setAddOpen(false)}
          onSaved={async (name) => {
            setAddOpen(false);
            setNotice(`${name} was added to branch raw materials.`);
            await load(true);
          }}
        />
      )}

      {receiveOpen && (
        <ReceiveStockModal
          branchQuery={branchQuery}
          materials={materials}
          onClose={() => setReceiveOpen(false)}
          onSaved={async (message) => {
            setReceiveOpen(false);
            setNotice(message);
            await load(true);
          }}
        />
      )}

      {importOpen && (
        <ImportMaterialsModal
          onClose={() => setImportOpen(false)}
          onSaved={async (message) => {
            setImportOpen(false);
            setNotice(message);
            await load(true);
          }}
        />
      )}
    </div>
  );
}

function AddMaterialModal({ branchQuery, units, onClose, onSaved }) {
  const [form, setForm] = useState({ name: '', variant: '', unit: '' });
  const [unitList, setUnitList] = useState(units);
  const [newUnit, setNewUnit] = useState('');
  const [showNewUnit, setShowNewUnit] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const addUnit = async () => {
    setError('');
    try {
      const response = await api.post('/units', { name: newUnit });
      setUnitList((rows) => [...rows, response.data]);
      setForm((current) => ({ ...current, unit: response.data.name }));
      setNewUnit('');
      setShowNewUnit(false);
    } catch (caught) {
      setError(firstValidationMessage(caught));
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api.post('/profittrack/materials', {
        name: form.name.trim(),
        variant: form.variant.trim(),
        unit: form.unit,
      }, { query: branchQuery });
      await onSaved(form.name.trim());
    } catch (caught) {
      setError(firstValidationMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Add material"
      onClose={onClose}
      footer={(
        <>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" form="add-material-form" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" disabled={saving}>
            {saving ? 'Saving…' : 'Add material'}
          </button>
        </>
      )}
    >
      <Notice type="error">{error}</Notice>
      <form id="add-material-form" className="form-grid grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-[14px] max-[681px]:later:grid-cols-[1fr] [.branch-portal-financial_&>button]:min-h-[42px] [.branch-portal-financial_&>button]:[justify-self:start] [.branch-portal-financial_&>button]:p-[0_16px] [.branch-portal-financial_&>button]:border [.branch-portal-financial_&>button]:border-transparent [.branch-portal-financial_&>button]:rounded-[12px] [.branch-portal-financial_&>button]:text-[#fff] [.branch-portal-financial_&>button]:[background:linear-gradient(135deg,_var(--branch-accent),_color-mix(in_srgb,_var(--branch-accent)_70%,_#695cff))] [.branch-portal-financial_&>button]:[box-shadow:0_10px_24px_color-mix(in_srgb,_var(--branch-accent)_22%,_transparent)] [.branch-portal-financial_&>button]:text-[10px] [.branch-portal-financial_&>button]:font-[780] [.branch-portal-financial_&>button]:[transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [.branch-portal-financial_&>button:hover:not(:disabled)]:[transform:translateY(-2px)] [.branch-portal-financial_&>button:hover:not(:disabled)]:[box-shadow:0_14px_28px_color-mix(in_srgb,_var(--branch-accent)_29%,_transparent)] [.branch-portal-financial_&>button:hover:not(:disabled)]:[filter:saturate(1.08)] [.branch-portal-financial_&>button[type='button']]:min-h-[38px] [.branch-portal-financial_&>button[type='button']]:[justify-self:start] [.branch-portal-financial_&>button[type='button']]:p-[0_13px] [.branch-portal-financial_&>button[type='button']]:[border:1px_solid_color-mix(in_srgb,_var(--branch-accent)_22%,_var(--border))] [.branch-portal-financial_&>button[type='button']]:rounded-[11px] [.branch-portal-financial_&>button[type='button']]:text-text-secondary [.branch-portal-financial_&>button[type='button']]:[background:color-mix(in_srgb,_var(--branch-accent)_7%,_var(--panel))] [.branch-portal-financial_&>button[type='button']]:text-[9px] [.branch-portal-financial_&>button[type='button']]:font-[740] [.branch-portal-financial_&>button[type='button']:hover]:text-text [.branch-portal-financial_&>button[type='button']:hover]:border-[color:var(--branch-accent)] [.branch-portal-financial_&>button[type='button']:hover]:[background:color-mix(in_srgb,_var(--branch-accent)_12%,_var(--panel))] [#update-applicant-form_&]:gap-3" onSubmit={submit}>
        <Field label="Material name" required>
          <input required maxLength={150} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="e.g. Caramel Syrup" />
        </Field>
        <Field label="Variant">
          <input maxLength={100} value={form.variant} onChange={(event) => setForm({ ...form, variant: event.target.value })} placeholder="e.g. Original" />
        </Field>
        <Field label="Unit" required>
          <select required value={form.unit} onChange={(event) => {
            if (event.target.value === '__add') { setShowNewUnit(true); return; }
            setForm({ ...form, unit: event.target.value });
          }}>
            <option value="">Select a unit</option>
            {unitList.map((unit) => <option key={unit.id || unit.name} value={unit.name}>{unit.name}</option>)}
            <option value="__add">+ Add Unit</option>
          </select>
        </Field>
        {showNewUnit && (
          <Field label="New unit" hint="Letters only, unique." full>
            <div className="flex gap-2 items-center [&_input]:flex-[1_1_auto] [&_input]:min-w-0">
              <input maxLength={20} value={newUnit} onChange={(event) => setNewUnit(event.target.value)} placeholder="e.g. bottle" />
              <button type="button" onClick={() => void addUnit()} disabled={!newUnit.trim()}>Save unit</button>
            </div>
          </Field>
        )}
      </form>
    </Modal>
  );
}

function ReceiveStockModal({ branchQuery, materials, onClose, onSaved }) {
  const costing = useCosting();
  const [mode, setMode] = useState('request');
  const [requests, setRequests] = useState([]);
  const [requestId, setRequestId] = useState('');
  const [lines, setLines] = useState({});
  const [totalCost, setTotalCost] = useState('');
  const [form, setForm] = useState({ material_id: '', quantity: '', total_cost: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (mode !== 'request') return;
    let active = true;
    setLoading(true);
    api.get('/branch/workspace/receivable-requests', branchQuery)
      .then((response) => { if (active) setRequests(response.data || []); })
      .catch((caught) => { if (active) setError(firstValidationMessage(caught)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [mode, branchQuery]);

  // With costing: deliveries whose receipt cost is still missing (their quantities are
  // already on hand). Without costing: only deliveries not yet added to Branch Inventory.
  const openRequests = requests.filter((request) => (costing ? !request.cost_recorded : !request.received_at));
  const selectedRequest = openRequests.find((request) => String(request.id) === String(requestId));

  useEffect(() => {
    if (!selectedRequest) { setLines({}); return; }
    setLines(Object.fromEntries((selectedRequest.items || []).map((item) => [item.product_id, String(Number(item.quantity_requested))])));
  }, [selectedRequest]);

  const selectedMaterial = materials.find((material) => String(material.id) === String(form.material_id));

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (mode === 'manual') {
        await api.post('/profittrack/materials/receive', {
          material_id: Number(form.material_id),
          quantity_milli: Math.round(Number(form.quantity) * 1000),
          ...(costing ? { total_cost_cents: Math.round(Number(form.total_cost || 0) * 100) } : {}),
          idempotency_key: newKey(),
        }, { query: branchQuery });
        await onSaved('Stock received into branch raw materials.');
        return;
      }
      if (!selectedRequest) {
        setError('Choose a delivered supply request.');
        return;
      }
      const response = await api.post('/branch/workspace/receive-stock', {
        supply_request_id: Number(selectedRequest.id),
        ...(costing ? { total_cost_cents: Math.round(Number(totalCost || 0) * 100) } : {}),
        lines: (selectedRequest.items || [])
          .filter((item) => Number(lines[item.product_id]) > 0)
          .map((item) => ({ product_id: Number(item.product_id), quantity: Number(lines[item.product_id]) })),
      });
      await onSaved(response.message || 'Receipt saved.');
    } catch (caught) {
      setError(firstValidationMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Receive stock"
      onClose={onClose}
      footer={(
        <>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" form="receive-stock-form" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" disabled={saving}>
            {saving ? 'Saving…' : 'Receive stock'}
          </button>
        </>
      )}
    >
      <Notice type="error">{error}</Notice>
      <div className="flex flex-wrap gap-[6px] mb-[14px]" style={{ marginTop: 0 }}>
        <button type="button" className={`tab min-h-[34px] p-[7px_14px] border border-line rounded-[999px] [background:var(--surface-subtle)] text-text-secondary text-[9px] font-[720] cursor-pointer [transition:.16s_ease] hover:text-text hover:border-line-strong hover:[background:var(--hover)] later:[&.active]:text-accent-text later:[&.active]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] later:[&.active]:[background:var(--active)] ${mode === 'request' ? ' active [&.branch-selector-card]:border-[color:color-mix(in_srgb,_var(--accent)_46%,_var(--border))] [&.branch-selector-card]:[background:linear-gradient(145deg,_color-mix(in_srgb,_var(--accent)_7%,_var(--panel)),_var(--panel))] [&.branch-selector-card]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_8%,_transparent),_var(--shadow-md)] [&.duration-preset]:text-accent-text [&.duration-preset]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] [&.duration-preset]:[background:var(--active)] [&.inventory-chip]:text-[#fff] [&.inventory-chip]:border-transparent [&.inventory-chip]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [&.inventory-chip]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_26%,_transparent)] [.ap-tabs_&.ap-tab]:[background:rgba(123,_136,_255,_.18)] [.ap-tabs_&.ap-tab]:text-[#aeb6ff] [.ap-tabs_&.ap-tab]:border-transparent [.ap-tabs_&.ap-tab]:[box-shadow:none]' : ''}`} onClick={() => setMode('request')}>From supply request</button>
        <button type="button" className={`tab min-h-[34px] p-[7px_14px] border border-line rounded-[999px] [background:var(--surface-subtle)] text-text-secondary text-[9px] font-[720] cursor-pointer [transition:.16s_ease] hover:text-text hover:border-line-strong hover:[background:var(--hover)] later:[&.active]:text-accent-text later:[&.active]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] later:[&.active]:[background:var(--active)] ${mode === 'manual' ? ' active [&.branch-selector-card]:border-[color:color-mix(in_srgb,_var(--accent)_46%,_var(--border))] [&.branch-selector-card]:[background:linear-gradient(145deg,_color-mix(in_srgb,_var(--accent)_7%,_var(--panel)),_var(--panel))] [&.branch-selector-card]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_8%,_transparent),_var(--shadow-md)] [&.duration-preset]:text-accent-text [&.duration-preset]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] [&.duration-preset]:[background:var(--active)] [&.inventory-chip]:text-[#fff] [&.inventory-chip]:border-transparent [&.inventory-chip]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [&.inventory-chip]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_26%,_transparent)] [.ap-tabs_&.ap-tab]:[background:rgba(123,_136,_255,_.18)] [.ap-tabs_&.ap-tab]:text-[#aeb6ff] [.ap-tabs_&.ap-tab]:border-transparent [.ap-tabs_&.ap-tab]:[box-shadow:none]' : ''}`} onClick={() => setMode('manual')}>Manual</button>
      </div>

      <form id="receive-stock-form" className="form-grid grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-[14px] max-[681px]:later:grid-cols-[1fr] [.branch-portal-financial_&>button]:min-h-[42px] [.branch-portal-financial_&>button]:[justify-self:start] [.branch-portal-financial_&>button]:p-[0_16px] [.branch-portal-financial_&>button]:border [.branch-portal-financial_&>button]:border-transparent [.branch-portal-financial_&>button]:rounded-[12px] [.branch-portal-financial_&>button]:text-[#fff] [.branch-portal-financial_&>button]:[background:linear-gradient(135deg,_var(--branch-accent),_color-mix(in_srgb,_var(--branch-accent)_70%,_#695cff))] [.branch-portal-financial_&>button]:[box-shadow:0_10px_24px_color-mix(in_srgb,_var(--branch-accent)_22%,_transparent)] [.branch-portal-financial_&>button]:text-[10px] [.branch-portal-financial_&>button]:font-[780] [.branch-portal-financial_&>button]:[transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [.branch-portal-financial_&>button:hover:not(:disabled)]:[transform:translateY(-2px)] [.branch-portal-financial_&>button:hover:not(:disabled)]:[box-shadow:0_14px_28px_color-mix(in_srgb,_var(--branch-accent)_29%,_transparent)] [.branch-portal-financial_&>button:hover:not(:disabled)]:[filter:saturate(1.08)] [.branch-portal-financial_&>button[type='button']]:min-h-[38px] [.branch-portal-financial_&>button[type='button']]:[justify-self:start] [.branch-portal-financial_&>button[type='button']]:p-[0_13px] [.branch-portal-financial_&>button[type='button']]:[border:1px_solid_color-mix(in_srgb,_var(--branch-accent)_22%,_var(--border))] [.branch-portal-financial_&>button[type='button']]:rounded-[11px] [.branch-portal-financial_&>button[type='button']]:text-text-secondary [.branch-portal-financial_&>button[type='button']]:[background:color-mix(in_srgb,_var(--branch-accent)_7%,_var(--panel))] [.branch-portal-financial_&>button[type='button']]:text-[9px] [.branch-portal-financial_&>button[type='button']]:font-[740] [.branch-portal-financial_&>button[type='button']:hover]:text-text [.branch-portal-financial_&>button[type='button']:hover]:border-[color:var(--branch-accent)] [.branch-portal-financial_&>button[type='button']:hover]:[background:color-mix(in_srgb,_var(--branch-accent)_12%,_var(--panel))] [#update-applicant-form_&]:gap-3" onSubmit={submit}>
        {mode === 'manual' ? (
          <>
            <Field label="Material" required full>
              <select required value={form.material_id} onChange={(event) => setForm({ ...form, material_id: event.target.value })}>
                <option value="">Select a material</option>
                {materials.map((material) => (
                  <option key={material.id} value={material.id}>{material.name}{material.variant ? ` · ${material.variant}` : ''} ({material.unit})</option>
                ))}
              </select>
            </Field>
            <Field label={`Quantity${selectedMaterial ? ` (${selectedMaterial.unit})` : ''}`} required>
              <input required type="number" min="0.001" step="0.001" value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} />
            </Field>
            {costing && (
              <Field label="Total receipt cost (PHP)" required>
                <input required type="number" min="0" step="0.01" value={form.total_cost} onChange={(event) => setForm({ ...form, total_cost: event.target.value })} />
              </Field>
            )}
          </>
        ) : (
          <>
            <Field label="Delivered supply request" required full>
              <select required value={requestId} onChange={(event) => setRequestId(event.target.value)} disabled={loading}>
                <option value="">{loading ? 'Loading delivered requests…' : 'Select a delivered request'}</option>
                {openRequests.map((request) => (
                  <option key={request.id} value={request.id}>{request.request_number} · {formatDate(request.created_at)}{costing && request.received_at ? ' · cost missing' : ''}</option>
                ))}
              </select>
            </Field>
            {openRequests.length === 0 && !loading && (
              <p className="muted-note text-muted text-[8px] leading-[1.6]">{costing ? 'Every delivered request already has its stock and receipt cost.' : 'Every delivered request is already in Branch Inventory.'} Deliveries are added to Branch Inventory automatically when Logistics marks them Delivered.</p>
            )}
            {selectedRequest && (
              <p className="muted-note text-muted text-[8px] leading-[1.6]">
                {selectedRequest.received_at
                  ? 'The quantities below are already on hand. Enter the total receipt cost to set their value.'
                  : 'These delivered quantities will be added to Branch Inventory once you confirm.'}
              </p>
            )}
            {selectedRequest && (
              <div className="grid gap-[10px] mt-1 [&_table]:min-w-0 [&_input]:min-h-[34px] [&_input]:w-[110px] [&_input]:p-[4px_8px]" style={{ gridColumn: '1 / -1' }}>
                <table>
                  <thead><tr><th>Item</th><th>Delivered</th><th>Received quantity</th></tr></thead>
                  <tbody>
                    {(selectedRequest.items || []).map((item) => (
                      <tr key={item.id}>
                        <td>{item.product?.name || item.product_name_snapshot || 'Item'}<small>{item.product?.unit || item.unit_snapshot || ''}</small></td>
                        <td>{formatNumber(item.quantity_requested)}</td>
                        <td>
                          {selectedRequest.received_at ? (
                            <span>{formatNumber(lines[item.product_id] ?? item.quantity_requested)} · on hand</span>
                          ) : (
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={lines[item.product_id] ?? ''}
                              onChange={(event) => setLines((current) => ({ ...current, [item.product_id]: event.target.value }))}
                            />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {costing && (
                  <Field label="Total receipt cost (PHP)" required>
                    <input required type="number" min="0" step="0.01" value={totalCost} onChange={(event) => setTotalCost(event.target.value)} />
                  </Field>
                )}
              </div>
            )}
          </>
        )}
      </form>
    </Modal>
  );
}

function ImportMaterialsModal({ onClose, onSaved }) {
  const costing = useCosting();
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState(null);
  const [resolutions, setResolutions] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const readFile = async (event) => {
    const file = event.target.files?.[0];
    setPreview(null);
    setCsv('');
    setResolutions({});
    setError('');
    if (!file) return;
    if (file.size > 1048576) {
      setError('CSV must be 1 MiB or smaller.');
      return;
    }
    try {
      setCsv(new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()));
      setFileName(file.name);
    } catch {
      setError('Could not read this file as UTF-8 CSV.');
    }
  };

  const runPreview = async (event) => {
    event.preventDefault();
    if (!csv) return;
    setBusy(true);
    setError('');
    try {
      const response = await api.post('/branch/workspace/materials-preview', { csv });
      setPreview(response.data);
      setResolutions({});
    } catch (caught) {
      setError(firstValidationMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    setBusy(true);
    setError('');
    try {
      const response = await api.post('/branch/workspace/materials-import', { csv, resolutions });
      await onSaved(`${response.data?.created || 0} new material(s) created; ${response.data?.updated || 0} row(s) received.`);
    } catch (caught) {
      setError(firstValidationMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const unresolved = (preview?.duplicates || []).filter((duplicate) => !['combine', 'remove'].includes(resolutions[duplicate.key]));

  return (
    <Modal
      title="Import raw materials CSV"
      onClose={onClose}
      footer={(
        <>
          <button type="button" onClick={() => void downloadFile('/branch/workspace/materials-template', {}, 'raw_materials_template.csv')}>
            Download CSV Template
          </button>
          <button type="button" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]"
            onClick={() => void apply()}
            disabled={!preview || preview.error_count > 0 || !preview.valid_count || unresolved.length > 0 || busy}
          >
            {busy ? 'Working…' : 'Apply import'}
          </button>
        </>
      )}
    >
      <Notice type="error">{error}</Notice>
      <p className="muted-note text-muted text-[8px] leading-[1.6]">
        New materials are created when the name, variant and unit are new. Units come from the shared unit list.
        A material already in the file or in inventory asks for Combine or Remove before applying.
      </p>
      <form className="form-grid grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-[14px] max-[681px]:later:grid-cols-[1fr] [.branch-portal-financial_&>button]:min-h-[42px] [.branch-portal-financial_&>button]:[justify-self:start] [.branch-portal-financial_&>button]:p-[0_16px] [.branch-portal-financial_&>button]:border [.branch-portal-financial_&>button]:border-transparent [.branch-portal-financial_&>button]:rounded-[12px] [.branch-portal-financial_&>button]:text-[#fff] [.branch-portal-financial_&>button]:[background:linear-gradient(135deg,_var(--branch-accent),_color-mix(in_srgb,_var(--branch-accent)_70%,_#695cff))] [.branch-portal-financial_&>button]:[box-shadow:0_10px_24px_color-mix(in_srgb,_var(--branch-accent)_22%,_transparent)] [.branch-portal-financial_&>button]:text-[10px] [.branch-portal-financial_&>button]:font-[780] [.branch-portal-financial_&>button]:[transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [.branch-portal-financial_&>button:hover:not(:disabled)]:[transform:translateY(-2px)] [.branch-portal-financial_&>button:hover:not(:disabled)]:[box-shadow:0_14px_28px_color-mix(in_srgb,_var(--branch-accent)_29%,_transparent)] [.branch-portal-financial_&>button:hover:not(:disabled)]:[filter:saturate(1.08)] [.branch-portal-financial_&>button[type='button']]:min-h-[38px] [.branch-portal-financial_&>button[type='button']]:[justify-self:start] [.branch-portal-financial_&>button[type='button']]:p-[0_13px] [.branch-portal-financial_&>button[type='button']]:[border:1px_solid_color-mix(in_srgb,_var(--branch-accent)_22%,_var(--border))] [.branch-portal-financial_&>button[type='button']]:rounded-[11px] [.branch-portal-financial_&>button[type='button']]:text-text-secondary [.branch-portal-financial_&>button[type='button']]:[background:color-mix(in_srgb,_var(--branch-accent)_7%,_var(--panel))] [.branch-portal-financial_&>button[type='button']]:text-[9px] [.branch-portal-financial_&>button[type='button']]:font-[740] [.branch-portal-financial_&>button[type='button']:hover]:text-text [.branch-portal-financial_&>button[type='button']:hover]:border-[color:var(--branch-accent)] [.branch-portal-financial_&>button[type='button']:hover]:[background:color-mix(in_srgb,_var(--branch-accent)_12%,_var(--panel))] [#update-applicant-form_&]:gap-3" onSubmit={runPreview}>
        <Field label="CSV file" required hint={fileName || (costing ? 'material_name,variant,unit,quantity,unit_cost' : 'material_name,variant,unit,quantity')}>
          <input type="file" accept=".csv,text/csv" onChange={readFile} />
        </Field>
        <button type="submit" disabled={!csv || busy}>{busy ? 'Checking…' : 'Preview import'}</button>
      </form>

      {preview && (
        <div className="grid gap-[10px] mt-[14px] later:[&>p]:m-0 later:[&>p]:text-text-secondary [&>p]:text-[11px]">
          <p><strong>{preview.valid_count}</strong> valid row(s) · <strong>{preview.error_count}</strong> row error(s) · <strong>{preview.duplicates?.length || 0}</strong> duplicate(s)</p>
          {preview.errors?.length > 0 && (
            <ul className="m-0 p-[10px_14px_10px_28px] rounded-[10px] border border-[color:color-mix(in_srgb,_#f56d7d_34%,_var(--border))] text-[#f56d7d] [background:color-mix(in_srgb,_#f56d7d_8%,_transparent)] text-[10px]">
              {preview.errors.map((row) => <li key={`${row.line}-${row.message}`}>Line {row.line}: {row.message}</li>)}
            </ul>
          )}
          {preview.duplicates?.length > 0 && (
            <div className="grid gap-2 p-3 border border-line rounded-[12px] [background:var(--surface-subtle)] [&_h3]:m-0 [&_h3]:text-text [&_h3]:text-[11px]">
              <h3>Duplicates need a decision</h3>
              {preview.duplicates.map((duplicate) => (
                <div key={duplicate.key} className="flex flex-wrap gap-[10px] items-center justify-between text-text-secondary text-[10px] [&_select]:min-h-[32px] [&_select]:p-[0_8px]">
                  <span>
                    {duplicate.label} · lines {duplicate.rows.map((row) => row.line).join(', ')}
                    {duplicate.in_inventory ? ' · already in inventory' : ''}
                  </span>
                  <select
                    value={resolutions[duplicate.key] || ''}
                    onChange={(event) => setResolutions((current) => ({ ...current, [duplicate.key]: event.target.value }))}
                    aria-label={`Resolve duplicate ${duplicate.label}`}
                  >
                    <option value="">Choose…</option>
                    <option value="combine">Combine</option>
                    <option value="remove">Remove</option>
                  </select>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

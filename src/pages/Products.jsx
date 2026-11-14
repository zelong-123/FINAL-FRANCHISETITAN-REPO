import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FaImage, FaPlus, FaTrashCan, FaUtensils } from 'react-icons/fa6';
import { api, firstValidationMessage } from '../lib/api';
import useRemote from '../lib/useRemote';
import { formatNumber } from '../lib/format';
import { EmptyState, Field, LoadingState, Modal, Notice, StatusBadge } from '../components/ApiUi';
import ProductImage from '../components/ProductImage';
import SlidingPagination from '../components/SlidingPagination';
import { PRODUCT_IMAGE_ACCEPT, productImageError } from '../lib/productImage';

const EMPTY_FORM = { name: '', brand_id: '', description: '', is_active: false };
const PAGE_SIZE = 10;

/**
 * Admin → Products. Finished products of a brand (name, picture, status) with the
 * recipe that production deducts: each ingredient is a warehouse stock item with a
 * batch amount and the number of pieces that batch makes.
 */
export default function Products() {
  const [brandId, setBrandId] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [brands, setBrands] = useState([]);
  const [editing, setEditing] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const [page, setPage] = useState(1);

  // One page of products at a time (the API counts and orders them).
  const remote = useRemote(
    async () => api.get('/brand-products', {
      page,
      per_page: PAGE_SIZE,
      ...(brandId ? { brand_id: brandId } : {}),
      ...(query ? { search: query } : {}),
    }),
    [page, brandId, query],
  );
  const { reload } = remote;

  useEffect(() => {
    api.get('/brands').then((response) => setBrands(response.data || [])).catch(() => setBrands([]));
  }, []);

  // A new search starts again from page 1.
  useEffect(() => {
    const next = search.trim();
    if (next === query) return undefined;
    const timer = window.setTimeout(() => { setQuery(next); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [search, query]);

  const products = remote.data?.data || [];
  const meta = remote.data?.meta;
  const brandName = (id) => brands.find((brand) => Number(brand.id) === Number(id))?.name || '—';

  return (
    <div className="page-container w-[min(100%,_1640px)] m-[0_auto] p-[clamp(22px,_3vw,_38px)] max-[861px]:later:p-[22px_17px_30px] [--sr-accent:var(--accent,_#2f7de1)] [--sr-accent-soft:rgba(47,_125,_225,_0.18)] [--sr-text:var(--text,_#f4f4f5)] [--sr-muted:var(--text-muted,_#a1a1aa)] [--sr-border:var(--border,_#2e2e33)] [--sr-border-strong:var(--border-strong,_#3f3f46)] [--sr-surface-hover:var(--surface-hover,_rgba(255,_255,_255,_0.04))] [--sr-danger:var(--danger-text,_#f87171)] [--sr-success:var(--success-text,_#4ade80)] [--sr-todo:#3a3a40] products-page [&_td_small]:block [&_td_small]:mt-[2px] [&_td_small]:text-muted [&_.ghost-button_svg]:w-[11px] [&_.ghost-button_svg]:h-[11px] later-2:[&_td_small]:text-[13px]">
      <Notice type="success">{notice}</Notice>
      <Notice type="error">{remote.error || actionError}</Notice>

      <section className="data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65]">
        <div className="[.products-page_&]:grid [.products-page_&]:grid-cols-[190px_minmax(0,_1fr)_auto] [.products-page_&]:gap-[10px] [.products-page_&]:items-center [.products-page_&_select]:min-h-[40px] [.products-page_&_select]:w-full [.products-page_&_select]:p-[0_12px] [.products-page_&_select]:border [.products-page_&_select]:border-line [.products-page_&_select]:rounded-[10px] [.products-page_&_select]:text-text [.products-page_&_select]:[background:var(--input-bg,_var(--surface-subtle))] max-[981px]:later:[.products-page_&]:grid-cols-[minmax(0,_1fr)] later:[.products-page_&]:m-0 [.products-page_&]:p-[14px_18px] [.products-page_&]:border-b [.products-page_&]:border-b-line later:[.products-page_&_select]:text-[14px]">
          <select value={brandId} onChange={(event) => { setBrandId(event.target.value); setPage(1); }} aria-label="Filter by brand">
            <option value="">All brands</option>
            {brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
          </select>
          <input
            className="[.products-page_&]:min-h-[40px] [.products-page_&]:w-full [.products-page_&]:p-[0_12px] [.products-page_&]:border [.products-page_&]:border-line [.products-page_&]:rounded-[10px] [.products-page_&]:text-text [.products-page_&]:[background:var(--input-bg,_var(--surface-subtle))] [.products-page_&::placeholder]:text-[color:var(--placeholder,_var(--muted))] later:[.products-page_&]:text-[14px]"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search product name or SKU"
            aria-label="Search products"
          />
          <button type="button" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[40px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] whitespace-nowrap [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)]" onClick={() => { setEditing(null); setActionError(''); setNotice(''); setFormOpen(true); }}>
            <FaUtensils aria-hidden="true" /> Add product
          </button>
        </div>

        {remote.loading && !products.length ? <LoadingState label="Loading products…" /> : products.length === 0 ? (
          <EmptyState
            label="No products yet."
            detail="Add a product with a picture and at least one ingredient, then set it active so its brand's branches can produce it."
          />
        ) : (
          <div className="table-wrap overflow-x-auto [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer readable-list [&_table]:text-[14px] [&_th]:text-[12px] [&_th]:tracking-[.06em] [&_td_strong]:text-[15px] [&_td_strong]:font-[600] [&_td_small]:text-[13px] [&_td_button]:text-[13px]">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Brand</th>
                  <th>Recipe</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {products.map((product) => (
                  <tr key={product.id}>
                    <td>
                      <div className="flex items-center gap-[10px] min-w-0 [&_strong]:block [&_strong]:text-text [&_small]:block [&_small]:mt-[2px] [&_small]:text-muted [&_small]:text-[9px] later:[&_strong]:text-[length:inherit]">
                        <span className="w-[38px] h-[38px] flex-[0_0_auto] grid place-items-center overflow-hidden rounded-[10px] border border-line text-muted [background:var(--surface-subtle)] text-[14px] [&_img]:w-full [&_img]:h-full [&_img]:object-cover [.products-page_&]:w-[42px] [.products-page_&]:h-[42px]">
                          <ProductImage src={product.image_url} alt={product.name} fallback={<FaImage aria-hidden="true" />} />
                        </span>
                        <span>
                          <strong>{product.name}</strong>
                          <small>{product.sku}</small>
                        </span>
                      </div>
                    </td>
                    <td>{product.brand?.name || brandName(product.brand_id)}</td>
                    <td>
                      {(product.ingredients || []).length} ingredient{(product.ingredients || []).length === 1 ? '' : 's'}
                      {!product.recipe_complete && <small className="text-[color:var(--warning-text)]! font-[700]">Recipe incomplete</small>}
                    </td>
                    <td>
                      <StatusBadge value={product.is_active ? 'active' : 'inactive'} />
                      {product.is_active && !product.recipe_complete && <small className="text-[color:var(--warning-text)]! font-[700]">Blocked: no ingredients</small>}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px] small [&.ghost-button]:min-h-[32px] [&.ghost-button]:p-[0_10px] [&.ghost-button]:text-[12px]"
                        onClick={() => { setEditing(product); setActionError(''); setNotice(''); setFormOpen(true); }}
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {products.length > 0 && <SlidingPagination meta={meta} onPage={setPage} />}
      </section>

      {formOpen && (
        <ProductFormModal
          product={editing}
          brands={brands}
          defaultBrandId={brandId}
          onClose={() => setFormOpen(false)}
          onSaved={async (message) => {
            setFormOpen(false);
            setActionError('');
            setNotice(message);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function ProductFormModal({ product, brands, defaultBrandId, onClose, onSaved }) {
  const isEdit = Boolean(product);
  const [form, setForm] = useState(() => ({
    ...EMPTY_FORM,
    name: product?.name || '',
    brand_id: String(product?.brand_id || defaultBrandId || ''),
    description: product?.description || '',
    is_active: Boolean(product?.is_active),
  }));
  const [rows, setRows] = useState(() => (product?.ingredients || []).map((ingredient) => ({
    product_id: String(ingredient.product_id),
    batch_amount: String(ingredient.batch_amount ?? ''),
    yield_pieces: String(ingredient.yield_pieces ?? 1),
  })));
  const [stockItems, setStockItems] = useState([]);
  // Picture: a newly picked file (with its local preview URL), or a request to remove the saved one.
  const [imageFile, setImageFile] = useState(null);
  const [localPreview, setLocalPreview] = useState('');
  const [removeImage, setRemoveImage] = useState(false);
  const [imageError, setImageError] = useState('');
  const savedImage = removeImage ? '' : (product?.image_url || '');
  const imagePreview = localPreview || savedImage;
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const fileRef = useRef(null);
  const lock = useRef(false);

  // Free the local preview URL when it is replaced or the form closes.
  useEffect(() => () => { if (localPreview) URL.revokeObjectURL(localPreview); }, [localPreview]);

  useEffect(() => {
    if (!form.brand_id) {
      setStockItems([]);
      return;
    }
    let active = true;
    api.get('/products', { brand_id: form.brand_id, per_page: 100 })
      .then((response) => { if (active) setStockItems(response.data || []); })
      .catch(() => { if (active) setStockItems([]); });
    return () => { active = false; };
  }, [form.brand_id]);

  const itemById = useMemo(() => new Map(stockItems.map((item) => [Number(item.id), item])), [stockItems]);
  // A stock item can appear once: other rows' picks are hidden in each row's list.
  const optionsFor = (index) => {
    const taken = new Set(rows.reduce((ids, row, position) => (
      position === index || !row.product_id ? ids : [...ids, Number(row.product_id)]
    ), []));
    return stockItems.filter((item) => !taken.has(Number(item.id)));
  };

  const setRow = (index, key, value) => setRows((current) => current.map((row, position) => (
    position === index ? { ...row, [key]: value } : row
  )));

  const addRow = () => setRows((current) => [...current, { product_id: '', batch_amount: '', yield_pieces: '1' }]);

  const perPiece = (row) => {
    const item = itemById.get(Number(row.product_id));
    const amount = Number(row.batch_amount);
    const yieldPieces = Number(row.yield_pieces);
    if (!item || !Number.isFinite(amount) || amount <= 0 || !Number.isFinite(yieldPieces) || yieldPieces <= 0) return '—';
    return `${formatNumber(amount / yieldPieces, 3)} ${item.unit}`;
  };

  const validate = () => {
    if (!form.name.trim()) return 'Enter a product name.';
    if (!form.brand_id) return 'Choose a brand.';
    for (const [index, row] of rows.entries()) {
      const item = itemById.get(Number(row.product_id));
      if (!item) return `Choose a stock item for ingredient ${index + 1}.`;
      if (!(Number(row.batch_amount) > 0)) return `Ingredient ${index + 1}: the batch amount must be greater than zero.`;
      if (!(Number(row.yield_pieces) > 0)) return `Ingredient ${index + 1}: the yield must be at least 1 piece.`;
    }
    if (form.is_active && rows.length === 0) return 'Add at least one ingredient before activating this product.';
    return '';
  };

  const submit = async (event) => {
    event.preventDefault();
    if (lock.current) return;
    const message = validate();
    if (message) {
      setError(message);
      return;
    }
    lock.current = true;
    setSaving(true);
    setError('');
    try {
      const payload = {
        brand_id: Number(form.brand_id),
        name: form.name.trim(),
        description: form.description.trim() || null,
        is_active: form.is_active,
        ingredients: rows.map((row) => ({
          product_id: Number(row.product_id),
          batch_amount: Number(row.batch_amount),
          yield_pieces: Number(row.yield_pieces),
        })),
      };
      let saved = isEdit
        ? (await api.put(`/brand-products/${product.id}`, payload)).data
        : (await api.post('/brand-products', payload)).data;

      if (imageFile) {
        const body = new FormData();
        body.append('image', imageFile);
        const upload = await api.post(`/brand-products/${saved.id}/image`, body);
        saved = { ...saved, image_url: upload.data?.image_url || saved.image_url };
      } else if (removeImage && product?.image_url) {
        await api.delete(`/brand-products/${saved.id}/image`);
        saved = { ...saved, image_url: null };
      }

      await onSaved(isEdit ? `“${saved.name}” was saved.` : `“${saved.name}” was created.`);
    } catch (caught) {
      setError(firstValidationMessage(caught));
    } finally {
      lock.current = false;
      setSaving(false);
    }
  };

  const pickImage = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const problem = productImageError(file);
    if (problem) {
      setImageError(problem);
      event.target.value = '';
      return;
    }
    setImageError('');
    setImageFile(file);
    setLocalPreview(URL.createObjectURL(file));
  };

  const clearPicked = () => {
    setImageFile(null);
    setLocalPreview('');
    setImageError('');
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <Modal
      title={isEdit ? `Edit ${product.name}` : 'Add a product'}
      onClose={onClose}
      size="wide"
      footer={(
        <>
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" form="brand-product-form" disabled={saving}>
            {saving ? 'Saving…' : isEdit ? 'Save product' : 'Add product'}
          </button>
        </>
      )}
    >
      <Notice type="error">{error}</Notice>
      <form id="brand-product-form" className="grid gap-[18px]" onSubmit={submit}>
        <section className="products-form-section grid gap-3 min-w-0 [.products-form-section+&]:pt-[18px] [.products-form-section+&]:border-t [.products-form-section+&]:border-t-line [&>h3]:m-0 [&>h3]:text-text [&>h3]:text-[14px] [&>h3]:font-[700]" aria-labelledby="pf-basic">
          <h3 id="pf-basic">Basic information</h3>
          <div className="form-grid grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-[14px] max-[681px]:later:grid-cols-[1fr] [.branch-portal-financial_&>button]:min-h-[42px] [.branch-portal-financial_&>button]:[justify-self:start] [.branch-portal-financial_&>button]:p-[0_16px] [.branch-portal-financial_&>button]:border [.branch-portal-financial_&>button]:border-transparent [.branch-portal-financial_&>button]:rounded-[12px] [.branch-portal-financial_&>button]:text-[#fff] [.branch-portal-financial_&>button]:[background:linear-gradient(135deg,_var(--branch-accent),_color-mix(in_srgb,_var(--branch-accent)_70%,_#695cff))] [.branch-portal-financial_&>button]:[box-shadow:0_10px_24px_color-mix(in_srgb,_var(--branch-accent)_22%,_transparent)] [.branch-portal-financial_&>button]:text-[10px] [.branch-portal-financial_&>button]:font-[780] [.branch-portal-financial_&>button]:[transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [.branch-portal-financial_&>button:hover:not(:disabled)]:[transform:translateY(-2px)] [.branch-portal-financial_&>button:hover:not(:disabled)]:[box-shadow:0_14px_28px_color-mix(in_srgb,_var(--branch-accent)_29%,_transparent)] [.branch-portal-financial_&>button:hover:not(:disabled)]:[filter:saturate(1.08)] [.branch-portal-financial_&>button[type='button']]:min-h-[38px] [.branch-portal-financial_&>button[type='button']]:[justify-self:start] [.branch-portal-financial_&>button[type='button']]:p-[0_13px] [.branch-portal-financial_&>button[type='button']]:[border:1px_solid_color-mix(in_srgb,_var(--branch-accent)_22%,_var(--border))] [.branch-portal-financial_&>button[type='button']]:rounded-[11px] [.branch-portal-financial_&>button[type='button']]:text-text-secondary [.branch-portal-financial_&>button[type='button']]:[background:color-mix(in_srgb,_var(--branch-accent)_7%,_var(--panel))] [.branch-portal-financial_&>button[type='button']]:text-[9px] [.branch-portal-financial_&>button[type='button']]:font-[740] [.branch-portal-financial_&>button[type='button']:hover]:text-text [.branch-portal-financial_&>button[type='button']:hover]:border-[color:var(--branch-accent)] [.branch-portal-financial_&>button[type='button']:hover]:[background:color-mix(in_srgb,_var(--branch-accent)_12%,_var(--panel))] [#update-applicant-form_&]:gap-3">
            <Field label="Product name" required>
              <input required maxLength={150} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="e.g. Caramel Latte" />
            </Field>
            <Field label="Brand" required hint={isEdit ? 'Moving a product to another brand also requires re-picking its ingredients.' : undefined}>
              <select required value={form.brand_id} onChange={(event) => { setForm({ ...form, brand_id: event.target.value }); setRows([]); }}>
                <option value="">Select a brand</option>
                {brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
              </select>
            </Field>
            <Field label="Description (optional)" full>
              <textarea maxLength={500} rows={2} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
            </Field>
          </div>
        </section>

        <section className="products-form-section grid gap-3 min-w-0 [.products-form-section+&]:pt-[18px] [.products-form-section+&]:border-t [.products-form-section+&]:border-t-line [&>h3]:m-0 [&>h3]:text-text [&>h3]:text-[14px] [&>h3]:font-[700]" aria-labelledby="pf-picture">
          <h3 id="pf-picture">Product picture</h3>
          <div className="flex items-center later:gap-4 later:flex-nowrap p-[14px] border border-dashed border-line-strong rounded-[12px] max-[561px]:later-2:flex-wrap">
            <span className="w-[76px] h-[76px] grid place-items-center overflow-hidden border border-dashed border-line rounded-[12px] text-muted [background:var(--surface-subtle)] text-[20px] [&_img]:w-full [&_img]:h-full [&_img]:object-cover flex-none">
              <ProductImage src={imagePreview} alt="" fallback={<FaImage aria-hidden="true" />} />
            </span>
            <div className="grid gap-2 min-w-0">
              <input ref={fileRef} type="file" accept={PRODUCT_IMAGE_ACCEPT} hidden onChange={pickImage} />
              <div className="flex flex-wrap gap-2">
                <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]" onClick={() => fileRef.current?.click()}>
                  {imagePreview ? 'Replace picture' : 'Choose picture'}
                </button>
                {imageFile ? (
                  <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]" onClick={clearPicked}>Clear selection</button>
                ) : savedImage ? (
                  <button type="button" className="min-h-[38px] inline-flex items-center justify-center gap-[7px] p-[0_14px] rounded-[10px] text-[13px] font-[650] [transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] [&.small]:min-h-[32px] [&.small]:p-[0_10px] [&.small]:text-[12px] border later:border-[color:color-mix(in_srgb,_var(--danger)_38%,_transparent)] later:text-danger-text later:[background:color-mix(in_srgb,_var(--danger)_8%,_transparent)] [&:hover:not(:disabled)]:border-[color:color-mix(in_srgb,_var(--danger)_65%,_transparent)] [&:hover:not(:disabled)]:[background:color-mix(in_srgb,_var(--danger)_18%,_transparent)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]" onClick={() => setRemoveImage(true)}>Remove picture</button>
                ) : removeImage ? (
                  <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]" onClick={() => setRemoveImage(false)}>Undo remove</button>
                ) : null}
              </div>
              <small className="text-muted text-[12px] leading-[1.5]">Shown on the branch product cards. JPG, PNG or WEBP up to 5 MB.</small>
              {removeImage && !imageFile && <small className="block text-[0.8125rem] text-muted later:mt-0">The picture will be removed when you save.</small>}
              {imageError && <small className="block text-[0.8125rem] text-[color:var(--danger-text,_var(--danger))] later:mt-0" role="alert">{imageError}</small>}
            </div>
          </div>
        </section>

        <section className="products-form-section grid gap-3 min-w-0 [.products-form-section+&]:pt-[18px] [.products-form-section+&]:border-t [.products-form-section+&]:border-t-line [&>h3]:m-0 [&>h3]:text-text [&>h3]:text-[14px] [&>h3]:font-[700]" aria-labelledby="pf-recipe">
          <h3 id="pf-recipe">Recipe</h3>
          <div className="grid later:gap-[10px]">
            {rows.length === 0 ? (
              <p className="m-0 text-muted leading-[1.6] p-[14px] border border-line rounded-[10px] [background:var(--surface-subtle)] later:text-[13px]">No ingredients yet. Add at least one to activate the product.</p>
            ) : (
              <div className="grid gap-2 items-center later-2:grid-cols-[minmax(0,_1.6fr)_130px_100px_minmax(90px,_auto)_38px] max-[981px]:later-3:grid-cols-[minmax(0,_1fr)_110px_90px_38px] [&_input]:w-full [&_input]:min-w-0 later:[&_input]:min-h-[40px] later:[&_input]:p-[9px_11px] [&_input]:border [&_input]:border-input-line [&_input]:rounded-[11px] [&_input]:[outline:none] [&_input]:text-text [&_input]:[background:var(--input-bg)] [&_input]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease,_background_.18s_ease] [&_select]:w-full [&_select]:min-w-0 later:[&_select]:min-h-[40px] later:[&_select]:p-[9px_11px] [&_select]:border [&_select]:border-input-line [&_select]:rounded-[11px] [&_select]:[outline:none] [&_select]:text-text [&_select]:[background:var(--input-bg)] [&_select]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease,_background_.18s_ease] [&_input::placeholder]:text-placeholder [&_input:hover]:border-line-strong later:[&_select:hover]:border-line-strong later:[&_input:focus]:border-accent [&_input:focus]:[box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--accent)_11%,_transparent)] [&_input:focus]:[background:var(--input-focus-bg)] later-2:[&_select:focus]:border-accent [&_select:focus]:[box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--accent)_11%,_transparent)] later:[&_select:focus]:[background:var(--input-focus-bg)] text-muted text-[12px] font-[700] max-[981px]:later:hidden" aria-hidden="true">
                <span>Ingredient</span>
                <span>Batch amount</span>
                <span>Yield</span>
                <span>Per piece</span>
                <span />
              </div>
            )}
            {rows.map((row, index) => (
              <div key={index} className="grid gap-2 items-center later-2:grid-cols-[minmax(0,_1.6fr)_130px_100px_minmax(90px,_auto)_38px] max-[981px]:later-3:grid-cols-[minmax(0,_1fr)_110px_90px_38px] [&_input]:w-full [&_input]:min-w-0 later:[&_input]:min-h-[40px] later:[&_input]:p-[9px_11px] [&_input]:border [&_input]:border-input-line [&_input]:rounded-[11px] [&_input]:[outline:none] [&_input]:text-text [&_input]:[background:var(--input-bg)] [&_input]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease,_background_.18s_ease] [&_select]:w-full [&_select]:min-w-0 later:[&_select]:min-h-[40px] later:[&_select]:p-[9px_11px] [&_select]:border [&_select]:border-input-line [&_select]:rounded-[11px] [&_select]:[outline:none] [&_select]:text-text [&_select]:[background:var(--input-bg)] [&_select]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease,_background_.18s_ease] [&_input::placeholder]:text-placeholder [&_input:hover]:border-line-strong later:[&_select:hover]:border-line-strong later:[&_input:focus]:border-accent [&_input:focus]:[box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--accent)_11%,_transparent)] [&_input:focus]:[background:var(--input-focus-bg)] later-2:[&_select:focus]:border-accent [&_select:focus]:[box-shadow:0_0_0_4px_color-mix(in_srgb,_var(--accent)_11%,_transparent)] later:[&_select:focus]:[background:var(--input-focus-bg)]">
                <select
                  required
                  value={row.product_id}
                  onChange={(event) => setRow(index, 'product_id', event.target.value)}
                  aria-label={`Stock item for ingredient ${index + 1}`}
                >
                  <option value="">Select a stock item</option>
                  {optionsFor(index).map((item) => (
                    <option key={item.id} value={item.id}>{item.name} ({item.unit})</option>
                  ))}
                </select>
                <input
                  required
                  type="number"
                  min="0.001"
                  step="0.001"
                  value={row.batch_amount}
                  onChange={(event) => setRow(index, 'batch_amount', event.target.value)}
                  placeholder="Batch amount"
                  aria-label={`Batch amount for ingredient ${index + 1}`}
                />
                <input
                  required
                  type="number"
                  min="1"
                  step="1"
                  value={row.yield_pieces}
                  onChange={(event) => setRow(index, 'yield_pieces', event.target.value)}
                  placeholder="Yield (pcs)"
                  aria-label={`Yield for ingredient ${index + 1}`}
                />
                <span className="text-muted whitespace-nowrap later:text-[13px] later:font-[600] max-[981px]:col-span-full max-[981px]:row-[2]">{perPiece(row)}</span>
                <button
                  type="button"
                  className="border border-[color:color-mix(in_srgb,_var(--danger)_38%,_transparent)] text-danger-text [background:color-mix(in_srgb,_var(--danger)_8%,_transparent)] [&:hover:not(:disabled)]:border-[color:color-mix(in_srgb,_var(--danger)_65%,_transparent)] [&:hover:not(:disabled)]:[background:color-mix(in_srgb,_var(--danger)_18%,_transparent)] w-[38px] h-[38px] inline-grid place-items-center p-0 rounded-[10px] [transition:background_.16s_ease,_border-color_.16s_ease] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]"
                  aria-label={`Remove ingredient ${index + 1}`}
                  title="Remove ingredient"
                  onClick={() => setRows((current) => current.filter((_, position) => position !== index))}
                >
                  <FaTrashCan aria-hidden="true" />
                </button>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-[10px]">
              <button type="button" className="min-h-[38px] inline-flex items-center justify-center gap-[7px] p-[0_14px] border border-line-strong rounded-[10px] [background:transparent] text-[13px] font-[650] [transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] [&:hover:not(:disabled)]:text-text [&:hover:not(:disabled)]:border-accent [&:hover:not(:disabled)]:[background:var(--hover)] border-dashed later:text-accent-text focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]" onClick={addRow} disabled={!form.brand_id || stockItems.length === 0}>
                <FaPlus aria-hidden="true" /> Add ingredient
              </button>
              {!form.brand_id && <small className="text-muted text-[12px] leading-[1.5]">Select a brand to add ingredients.</small>}
              {form.brand_id && stockItems.length === 0 && (
                <small className="text-muted text-[12px] leading-[1.5]">This brand has no warehouse stock items yet. Add them in Warehouse inventory first.</small>
              )}
            </div>
            <small className="text-muted text-[12px] leading-[1.5]">Batch amount is in the stock item's own unit; the yield is how many pieces that batch makes. Quantity per piece = batch amount ÷ yield.</small>
          </div>
        </section>

        <section className="products-form-section grid gap-3 min-w-0 [.products-form-section+&]:pt-[18px] [.products-form-section+&]:border-t [.products-form-section+&]:border-t-line [&>h3]:m-0 [&>h3]:text-text [&>h3]:text-[14px] [&>h3]:font-[700]" aria-labelledby="pf-status">
          <h3 id="pf-status">Status</h3>
          <label className="inline-flex items-center gap-2 text-text-secondary font-[650] later:min-h-0 later:text-[13px]">
            <input type="checkbox" checked={form.is_active} onChange={(event) => setForm({ ...form, is_active: event.target.checked })} />
            Active — visible to this brand's branches
          </label>
        </section>
      </form>
    </Modal>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FaMagnifyingGlass } from 'react-icons/fa6';
import { api, firstValidationMessage } from '../../lib/api';
import { EmptyState, LoadingState, Modal, Notice } from '../ApiUi';
import ProductImage from '../ProductImage';
import { formatNumber } from '../../lib/format';

/**
 * Products: the published brand products of this branch, with a franchisee-only
 * Active/Archived toggle (archive means is_active false; nothing is deleted).
 * Picture + recipe live on the brand product; Admin edits them in Products.
 */
export default function BranchProductsPanel({ branchQuery = {}, role }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openProduct, setOpenProduct] = useState(null);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState('active');
  const [notice, setNotice] = useState('');
  const [confirmTarget, setConfirmTarget] = useState(null);
  const [actingId, setActingId] = useState(null);
  const isAdmin = role === 'admin';
  // Only the branch owner archives its products; Admin stays view-only here.
  const canArchive = role === 'franchisee';

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const response = await api.get('/branch/workspace/products', {
        ...branchQuery,
        ...(tab === 'archived' ? { archived: 1 } : {}),
      });
      setData(response.data);
      setError('');
    } catch (caught) {
      setError(firstValidationMessage(caught));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [branchQuery, tab]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [load]);

  const runAction = async () => {
    if (!confirmTarget || actingId) return;
    setActingId(confirmTarget.product.id);
    setError('');
    try {
      const response = await api.post(`/branch/workspace/products/${confirmTarget.product.id}/${confirmTarget.action}`, {}, { query: branchQuery });
      setNotice(response.data?.message || 'Product updated.');
      setConfirmTarget(null);
      await load(true);
    } catch (caught) {
      setError(firstValidationMessage(caught));
      setConfirmTarget(null);
    } finally {
      setActingId(null);
    }
  };

  const products = data?.products || [];
  const visibleProducts = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return products;
    return products.filter((product) => [product.name, product.sku, product.description]
      .some((value) => String(value || '').toLowerCase().includes(term)));
  }, [products, query]);
  const brandName = data?.brand?.name || 'this brand';
  const hasMaterials = Boolean(data?.has_materials);

  return (
    <div className="branch-products">
      <Notice type="success">{notice}</Notice>
      <Notice type="error">{error}</Notice>

      <section className="data-panel overflow-hidden mb-[18px] p-[20px] border border-line rounded-[8px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65]">
        <div className="branch-panel-heading flex items-start justify-between gap-[14px] mb-[14px] [&_h2]:m-0 [&_h2]:text-text [&_h2]:text-[16px] [&_p]:m-[5px_0_0] [&_p]:text-muted [&_p]:text-[11px] [&_p]:leading-[1.6]">
          <div>
            <h2>Products</h2>
            <p>
              {tab === 'archived'
                ? 'Products this branch archived. Nothing is deleted, and their production history stays.'
                : `Active ${brandName} products with their picture and recipe.`}
              {isAdmin
                ? ' Admin edits products and recipes in the Products screen.'
                : canArchive ? ' Archive a product you no longer make so it leaves the Production dropdown.' : ' Branch users have view-only access.'}
            </p>
          </div>
          {data && (
            <div className="flex flex-wrap items-center justify-end gap-2 flex-none max-[640px]:w-full">
              <div role="tablist" aria-label="Product status" className="flex p-[3px] border border-line rounded-[10px] [background:var(--input-bg)]">
                {[['active', 'Active'], ['archived', 'Archived']].map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={tab === key}
                    className={`min-h-[34px] border-0 rounded-[8px] p-[0_14px] text-[12.5px] font-[650] cursor-pointer [transition:color_.16s_ease,_background_.16s_ease] ${tab === key ? 'text-text [background:var(--hover)]' : 'text-muted [background:transparent] hover:text-text'}`}
                    onClick={() => { setQuery(''); setData(null); setLoading(true); setTab(key); }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            <label className="flex items-center gap-2 flex-none w-[240px] max-w-[45%] px-3 py-2 border rounded-[8px] [border-color:var(--branch-accent)] [background:var(--input-bg)] text-muted focus-within:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--branch-accent)_17%,_transparent)] max-[640px]:w-full max-[640px]:max-w-none">
              <FaMagnifyingGlass aria-hidden="true" className="flex-none text-[12px]" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search products…"
                aria-label="Search products"
                className="w-full min-w-0 bg-transparent border-0 outline-none text-text text-[12px] placeholder:text-placeholder"
              />
            </label>
            </div>
          )}
        </div>

        {loading && !data ? <LoadingState label="Loading products…" /> : (
          <>
            {!hasMaterials && tab === 'active' && (
              <Notice type="info">
                This branch has no raw materials yet, so these products cannot be produced until stock is received.
              </Notice>
            )}
            {visibleProducts.length === 0 ? (
              <EmptyState
                label={products.length === 0
                  ? (tab === 'archived' ? 'No archived products.' : `No products have been published for ${brandName} yet.`)
                  : `No products match “${query.trim()}”.`}
                detail={products.length === 0
                  ? (tab === 'archived'
                    ? 'Archive a product from the Active tab and it appears here. Nothing is deleted.'
                    : isAdmin ? 'Create a product with a picture and recipe in Products, then set it Active.' : 'Ask Admin to publish a product with a picture and recipe for your brand.')
                  : 'Try a different name or SKU.'}
              />
            ) : (
            <div className="grid grid-cols-[repeat(auto-fill,_minmax(300px,_1fr))] gap-4">
              {visibleProducts.map((product) => (
                <div
                  key={product.id}
                  className="grid border border-line rounded-[8px] [background:var(--surface-subtle)] text-text [transition:transform_.16s_ease,_border-color_.16s_ease,_box-shadow_.16s_ease] hover:[transform:translateY(-2px)] hover:border-[color:color-mix(in_srgb,_var(--branch-accent)_40%,_var(--border))] hover:[box-shadow:var(--shadow-md)]"
                >
                  <button
                    type="button"
                    className="grid gap-3 p-4 text-left text-text border-0 [background:transparent] cursor-pointer"
                    onClick={() => setOpenProduct(product)}
                  >
                  <span className="flex items-center gap-3 pb-3 border-b border-line">
                    <span className="w-[76px] h-[76px] flex-none grid place-items-center overflow-hidden rounded-[6px] border border-line [&_img]:w-full [&_img]:h-full [&_img]:object-cover">
                      <ProductImage
                        src={product.image_url}
                        alt={product.name}
                        fallback={<span className="text-[18px] font-[800] text-muted" aria-hidden="true">{(product.name || 'P').slice(0, 1).toUpperCase()}</span>}
                      />
                    </span>
                    <span className="grid gap-1 min-w-0">
                      <strong className="text-[16px] font-[700] leading-[1.25] break-words">{product.name}</strong>
                      {product.description && <span className="text-[13px] text-muted break-words">{product.description}</span>}
                      <span className="text-[12px] text-muted">{product.sku}</span>
                    </span>
                  </span>
                  <span className="grid gap-2">
                    <strong className="text-[13px] font-[700]">Recipe</strong>
                    {(product.ingredients || []).length === 0 ? (
                      <span className="text-[13px] text-muted">No ingredients yet.</span>
                    ) : (
                      <ul className="m-0 p-0 list-none grid gap-[6px]">
                        {product.ingredients.map((ingredient) => (
                          <li key={ingredient.product_id} className="flex items-center justify-between gap-3 text-[14px]">
                            <span className="min-w-0 truncate">{ingredient.name}</span>
                            <span className="flex-none text-[13px] text-muted">{formatNumber(ingredient.quantity_per_piece, 3)} {ingredient.unit}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </span>
                  </button>
                </div>
              ))}
            </div>
            )}
          </>
        )}
      </section>

      {confirmTarget && (
        <Modal
          title={confirmTarget.action === 'archive' ? `Archive ${confirmTarget.product.name}?` : `Unarchive ${confirmTarget.product.name}?`}
          onClose={() => (actingId ? null : setConfirmTarget(null))}
          size="small"
          footer={(
            <>
              <button type="button" onClick={() => setConfirmTarget(null)} disabled={Boolean(actingId)}>Cancel</button>
              <button
                type="button"
                className="min-h-[38px] inline-flex items-center justify-center gap-[7px] p-[0_14px] border border-transparent rounded-[10px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] text-[12.5px] font-[700] cursor-pointer disabled:opacity-[.6] disabled:cursor-not-allowed"
                onClick={runAction}
                disabled={Boolean(actingId)}
              >
                {actingId ? 'Saving…' : confirmTarget.action === 'archive' ? 'Archive product' : 'Unarchive product'}
              </button>
            </>
          )}
        >
          <p className="m-0 text-text-secondary text-[13px] leading-[1.55]">
            {confirmTarget.action === 'archive'
              ? 'This product will disappear from the Production dropdown and cannot be produced. Nothing is deleted: the product, its recipe and its production history stay, and you can unarchive it any time.'
              : 'This product goes back to the Production dropdown so the branch can produce it again. It needs at least one recipe ingredient.'}
          </p>
        </Modal>
      )}

      {openProduct && (
        <ProductModal
          product={openProduct}
          archived={openProduct.is_active === false}
          busy={actingId === openProduct.id}
          canArchive={canArchive}
          onToggleArchive={() => {
            const target = openProduct;
            setOpenProduct(null);
            setError('');
            setNotice('');
            setConfirmTarget({ product: target, action: target.is_active === false ? 'unarchive' : 'archive' });
          }}
          onClose={() => setOpenProduct(null)}
        />
      )}
    </div>
  );
}

function ProductModal({ product, onClose, canArchive, archived, busy, onToggleArchive }) {
  return (
    <Modal
      title={product.name || 'Product'}
      footer={<button type="button" onClick={onClose}>Close</button>}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-line [background:var(--surface-subtle)] p-[10px_12px]">
        <span className="text-[12.5px] text-muted">
          {archived ? 'Archived · not in the Production dropdown' : 'Active · in the Production dropdown'}
        </span>
        {canArchive && (
          <button
            type="button"
            className="min-h-[34px] inline-flex items-center justify-center gap-[7px] p-[0_14px] border border-line-strong rounded-[10px] [background:transparent] text-text-secondary text-[12.5px] font-[650] cursor-pointer [transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] hover:text-text hover:border-accent hover:[background:var(--hover)] disabled:opacity-[.5] disabled:cursor-not-allowed"
            disabled={busy}
            onClick={onToggleArchive}
          >
            {busy ? 'Saving…' : archived ? 'Unarchive product' : 'Archive product'}
          </button>
        )}
      </div>
      <div className="grid grid-cols-[220px_minmax(0,_1fr)] gap-4 max-[981px]:later:grid-cols-[minmax(0,_1fr)]">
        <div className="grid [align-content:start] gap-2 [&_img]:w-full [&_img]:[aspect-ratio:4_/_3] [&_img]:grid [&_img]:place-items-center [&_img]:overflow-hidden [&_img]:border [&_img]:border-dashed [&_img]:border-line [&_img]:rounded-[14px] [&_img]:text-muted [&_img]:text-[10px] [&_img]:[background:var(--surface-subtle)] [&_img]:object-cover [&>span]:w-full [&>span]:[aspect-ratio:4_/_3] [&>span]:grid [&>span]:place-items-center [&>span]:overflow-hidden [&>span]:border [&>span]:border-dashed [&>span]:border-line [&>span]:rounded-[14px] [&>span]:text-muted later:[&>span]:text-[10px] [&>span]:[background:var(--surface-subtle)] [&>span]:object-cover [&_small]:text-muted [&_small]:text-[9px] [&_strong]:text-text later:[&_strong]:text-[16px]">
          <ProductImage src={product.image_url} alt={product.name} fallback={<span>No product picture yet.</span>} />
          <small>{product.sku}</small>
        </div>
        <div className="[&_h3]:m-[0_0_8px] [&_h3]:text-text [&_h3]:text-[13px]">
          <h3>Recipe</h3>
          {product.description && <p className="muted-note text-muted text-[8px] leading-[1.6]">{product.description}</p>}
          {(product.ingredients || []).length === 0 ? (
            <EmptyState label="No recipe configured." detail="Admin adds the ingredients in Products." />
          ) : (
            <div className="table-wrap overflow-x-auto [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer">
              <table>
                <thead><tr><th>Ingredient</th><th>Per piece</th><th>Batch</th><th>On hand</th></tr></thead>
                <tbody>
                  {product.ingredients.map((ingredient) => (
                    <tr key={ingredient.product_id}>
                      <td>{ingredient.name}{ingredient.missing && <small>Not in branch inventory</small>}</td>
                      <td>{formatNumber(ingredient.quantity_per_piece, 3)} {ingredient.unit}</td>
                      <td>{formatNumber(ingredient.batch_amount, 3)} {ingredient.batch_unit} → {formatNumber(ingredient.yield_pieces)} pcs</td>
                      <td>{formatNumber(ingredient.available, 3)} {ingredient.unit}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

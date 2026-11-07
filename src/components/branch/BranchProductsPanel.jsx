import { useCallback, useEffect, useState } from 'react';
import { api, firstValidationMessage } from '../../lib/api';
import { EmptyState, LoadingState, Modal, Notice } from '../ApiUi';
import ProductImage from '../ProductImage';
import { formatNumber } from '../../lib/format';

/**
 * Products: the published brand products of this branch, read-only.
 * Picture + recipe live on the brand product; Admin edits them in Products.
 */
export default function BranchProductsPanel({ branchQuery = {}, role }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openProduct, setOpenProduct] = useState(null);
  const isAdmin = role === 'admin';

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const response = await api.get('/branch/workspace/products', branchQuery);
      setData(response.data);
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

  const products = data?.products || [];
  const brandName = data?.brand?.name || 'this brand';
  const hasMaterials = Boolean(data?.has_materials);

  return (
    <div className="branch-products">
      <Notice type="error">{error}</Notice>

      <section className="data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65]">
        <div className="branch-panel-heading flex items-start justify-between gap-[14px] mb-[14px] [&_h2]:m-0 [&_h2]:text-text [&_h2]:text-[16px] [&_p]:m-[5px_0_0] [&_p]:text-muted [&_p]:text-[11px] [&_p]:leading-[1.6]">
          <div>
            <h2>Products</h2>
            <p>
              Active {brandName} products with their picture and recipe.
              {isAdmin ? ' Admin edits products and recipes in the Products screen.' : ' Branch users have view-only access.'}
            </p>
          </div>
        </div>

        {loading && !data ? <LoadingState label="Loading products…" /> : products.length === 0 ? (
          <EmptyState
            label={`No products have been published for ${brandName} yet.`}
            detail={isAdmin ? 'Create a product with a picture and recipe in Products, then set it Active.' : 'Ask Admin to publish a product with a picture and recipe for your brand.'}
          />
        ) : (
          <>
            {!hasMaterials && (
              <Notice type="info">
                This branch has no raw materials yet, so these products cannot be produced until stock is received.
              </Notice>
            )}
            <div className="grid grid-cols-[repeat(auto-fill,_minmax(220px,_1fr))] gap-3">
              {products.map((product) => (
                <button
                  type="button"
                  key={product.id}
                  className="flex items-center gap-3 p-3 text-left border border-line rounded-[14px] [background:var(--surface-subtle)] text-text cursor-pointer [transition:transform_.16s_ease,_border-color_.16s_ease] hover:[transform:translateY(-2px)] hover:border-[color:color-mix(in_srgb,_var(--branch-accent)_30%,_var(--border))]"
                  onClick={() => setOpenProduct(product)}
                >
                  <span className="w-[52px] h-[52px] flex-[0_0_auto] grid place-items-center overflow-hidden rounded-[12px] text-[#fff] text-[18px] font-[800] [background:linear-gradient(145deg,_var(--branch-accent),_color-mix(in_srgb,_var(--branch-accent)_65%,_#141b2e))] [&_img]:w-full [&_img]:h-full [&_img]:object-cover">
                    <ProductImage
                      src={product.image_url}
                      alt={product.name}
                      fallback={<span aria-hidden="true">{(product.name || 'P').slice(0, 1).toUpperCase()}</span>}
                    />
                  </span>
                  <span className="grid gap-[3px] min-w-0 [&_strong]:text-[11px] [&_small]:text-muted [&_small]:text-[9px] [&_small]:overflow-hidden [&_small]:text-ellipsis [&_small]:whitespace-nowrap [&_span]:text-muted [&_span]:text-[9px] [&_span]:overflow-hidden [&_span]:text-ellipsis [&_span]:whitespace-nowrap">
                    <strong>{product.name}</strong>
                    <small>{product.sku}</small>
                    <span>
                      {formatNumber((product.ingredients || []).length)} ingredient{(product.ingredients || []).length === 1 ? '' : 's'}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </section>

      {openProduct && (
        <ProductModal product={openProduct} onClose={() => setOpenProduct(null)} />
      )}
    </div>
  );
}

function ProductModal({ product, onClose }) {
  return (
    <Modal
      title={product.name || 'Product'}
      onClose={onClose}
      footer={<button type="button" onClick={onClose}>Close</button>}
    >
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

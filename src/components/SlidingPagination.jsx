/**
 * Sliding window pager shared by the Warehouse & Inventory and Transaction History views.
 * meta: { current_page, last_page, per_page, total, from?, to? } — from/to are derived when absent.
 * Shows "Showing {from} to {to} of {total} items" on the left and Previous / up to 4 pages / Next.
 */
const WINDOW = 4;

export default function SlidingPagination({ meta, onPage }) {
  const total = Number(meta?.total ?? 0);
  if (!total) return null;

  const perPage = Number(meta?.per_page ?? 10) || 10;
  const last = Math.max(1, Number(meta?.last_page ?? Math.ceil(total / perPage)) || 1);
  const current = Math.min(Math.max(Number(meta?.current_page ?? 1), 1), last);
  const from = Number(meta?.from ?? ((current - 1) * perPage + 1));
  const to = Number(meta?.to ?? Math.min(current * perPage, total));

  const start = Math.max(1, Math.min(current - 1, last - WINDOW + 1));
  const pages = Array.from({ length: Math.min(WINDOW, last) }, (_, index) => start + index);

  return (
    <nav className="flex items-center justify-between flex-wrap gap-3 p-[14px_18px] border-t border-t-[#1a2133] [&_.page-count]:text-[0.88rem] [&_.page-count]:text-[#8590a8] [&_.page-nav]:flex [&_.page-nav]:items-center [&_.page-nav]:gap-[6px] [&_.page-nav]:ml-auto [&_button]:h-[36px] later-2:[&_button]:border later-4:[&_button]:border-[#1f2842] later-3:[&_button]:[background:transparent] later-2:[&_button]:text-[#b4bdd4] [&_button]:[font-family:inherit] later-4:[&_button]:[font-size:inherit] later-4:[&_button]:[font-weight:inherit] [&_button]:[font-style:inherit] later-2:[&_button]:[line-height:inherit] later:[&_button]:cursor-pointer later-2:[&_button]:[transition:background-color_0.2s_ease,_border-color_0.2s_ease,_color_0.2s_ease] [&_.page-step]:p-[0_14px] [&_.page-step]:rounded-[10px] [&_.page-number]:w-[36px] [&_.page-number]:p-0 [&_.page-number]:border-transparent [&_.page-number]:rounded-[50%] [&_.page-number]:font-[600] [&_.page-number:hover:not(.active)]:[background:rgba(123,_136,_255,_0.1)] [&_.page-number:hover:not(.active)]:border-[rgba(123,_136,_255,_0.35)] [&_.page-number:hover:not(.active)]:text-[#e6e9f2] [&_.page-step:hover:not(:disabled)]:[background:rgba(123,_136,_255,_0.1)] [&_.page-step:hover:not(:disabled)]:border-[rgba(123,_136,_255,_0.35)] [&_.page-step:hover:not(:disabled)]:text-[#e6e9f2] [&_.page-number.active]:[background:#7b88ff] [&_.page-number.active]:border-[#7b88ff] [&_.page-number.active]:text-[#fff] later-2:[&_button:disabled]:opacity-[0.4] [&_button:disabled]:cursor-not-allowed later-2:[&_button:focus-visible]:[outline:2px_solid_#7b88ff] later-2:[&_button:focus-visible]:[outline-offset:2px] max-[521px]:later:justify-center max-[521px]:later:[&_.page-nav]:ml-0" aria-label="Pagination">
      <span className="page-count">Showing {from} to {to} of {total} items</span>
      <div className="page-nav">
        <button type="button" className="page-step" onClick={() => onPage(current - 1)} disabled={current <= 1}>
          Previous
        </button>
        {pages.map((number) => (
          <button
            key={number}
            type="button"
            className={`page-number [.inquiry-pagination_&]:w-[36px] [.inquiry-pagination_&]:p-0 [.inquiry-pagination_&]:border-transparent [.inquiry-pagination_&]:rounded-[50%] [.inquiry-pagination_&]:font-[600] [.inquiry-pagination_&:hover:not(.active)]:[background:rgba(123,_136,_255,_0.1)] [.inquiry-pagination_&:hover:not(.active)]:border-[rgba(123,_136,_255,_0.35)] [.inquiry-pagination_&:hover:not(.active)]:text-[#e6e9f2] [.inquiry-pagination_&.active]:[background:#7b88ff] [.inquiry-pagination_&.active]:border-[#7b88ff] [.inquiry-pagination_&.active]:text-[#fff] ${number === current ? ' active [&.branch-selector-card]:border-[color:color-mix(in_srgb,_var(--accent)_46%,_var(--border))] [&.branch-selector-card]:[background:linear-gradient(145deg,_color-mix(in_srgb,_var(--accent)_7%,_var(--panel)),_var(--panel))] [&.branch-selector-card]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_8%,_transparent),_var(--shadow-md)] [&.duration-preset]:text-accent-text [&.duration-preset]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] [&.duration-preset]:[background:var(--active)] [&.inventory-chip]:text-[#fff] [&.inventory-chip]:border-transparent [&.inventory-chip]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [&.inventory-chip]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_26%,_transparent)] [.ap-tabs_&.ap-tab]:[background:rgba(123,_136,_255,_.18)] [.ap-tabs_&.ap-tab]:text-[#aeb6ff] [.ap-tabs_&.ap-tab]:border-transparent [.ap-tabs_&.ap-tab]:[box-shadow:none]' : ''}`}
            aria-label={`Page ${number}`}
            aria-current={number === current ? 'page' : undefined}
            onClick={() => onPage(number)}
          >
            {number}
          </button>
        ))}
        <button type="button" className="page-step" onClick={() => onPage(current + 1)} disabled={current >= last}>
          Next
        </button>
      </div>
    </nav>
  );
}

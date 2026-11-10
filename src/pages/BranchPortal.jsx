import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { FaBoxesStacked, FaChartLine, FaIndustry, FaRightFromBracket, FaStore, FaUtensils } from 'react-icons/fa6';
import { api, firstValidationMessage } from '../lib/api';
import { BRANCH_VIEWS, branchPlace, breadcrumbFor, resolveView } from '../lib/branchWorkspace';
import { useAuth } from '../context/AuthContext';
import { BRANCH_LOGIN_PATH } from '../lib/portal';
import { EmptyState, LoadingState, Notice } from '../components/ApiUi';
import BranchDashboardPanel from '../components/branch/BranchDashboardPanel';
import BranchRawMaterialsPanel from '../components/branch/BranchRawMaterialsPanel';
import BranchProductsPanel from '../components/branch/BranchProductsPanel';
import BranchProductionPanel from '../components/branch/BranchProductionPanel';
import BranchSupplyPanel from '../components/branch/BranchSupplyPanel';
import BranchTransactionsPanel from '../components/branch/BranchTransactionsPanel';

// Sales is intentionally absent: the branch workspace is production-only.
const navGroups = [
  [
    ['dashboard', FaChartLine],
    ['inventory', FaBoxesStacked],
    ['products', FaUtensils],
    ['production', FaIndustry],
  ],
  // Kept apart: requesting supply is one of the branch's main jobs.
  [['supply', FaStore]],
];

const brandAccent = (brand) => {
  const name = `${brand?.code || ''} ${brand?.name || ''}`.toLowerCase().replace(/[^a-z]/g, '');
  if (name.includes('kkopi')) return '#FF7A00';
  if (name.includes('godo')) return '#70B22C';
  if (name.includes('dailydash')) return '#0088FF';
  if (name.includes('lapasta')) return '#D32F2F';
  return '#6687ff';
};

function BranchPortal({ preview = false }) {
  const { logout, role, user } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [workspace, setWorkspace] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const requestedView = searchParams.get('view');
  const view = resolveView(requestedView);

  const previewCode = preview ? new URLSearchParams(window.location.search).get('branch_code') : '';
  const branchQuery = React.useMemo(
    () => (preview && previewCode ? { branch_code: previewCode } : {}),
    [preview, previewCode],
  );

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      if (preview && role === 'admin') {
        const response = await api.get('/branch/preview', { branch_code: previewCode });
        setWorkspace(response.data);
      } else {
        const response = await api.get('/branch/context');
        setWorkspace(response.data);
      }
      setError('');
    } catch (caught) {
      setError(firstValidationMessage(caught));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [preview, previewCode, role]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh(true);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // A retired or mistyped ?view= (such as the old Estimated Requirement tab) opens the dashboard.
  const viewSearch = useCallback((next) => {
    const params = new URLSearchParams(searchParams);
    if (next === 'dashboard') params.delete('view');
    else params.set('view', next);
    return params.toString();
  }, [searchParams]);

  useEffect(() => {
    if (requestedView && requestedView !== view) setSearchParams(viewSearch('dashboard'), { replace: true });
  }, [requestedView, view, viewSearch, setSearchParams]);

  useEffect(() => { window.scrollTo(0, 0); }, [view]);

  const goTo = (next) => setSearchParams(viewSearch(next));

  const location = workspace?.location;
  const accent = brandAccent(location?.brand);
  const ownerName = location?.franchisee?.user?.full_name || user?.full_name || 'Branch owner';
  const place = workspace ? branchPlace(location, ownerName) : 'Branch workspace';
  const crumbs = breadcrumbFor(view);

  if (role !== 'franchisee' && !(preview && role === 'admin')) return null;

  const handleSignOut = async () => {
    await logout();
    navigate(BRANCH_LOGIN_PATH, { replace: true });
  };

  return (
    <div className="branch-portal-page later:[--accent:var(--branch-accent,_#6687ff)] later:[--accent-2:var(--branch-accent,_#6687ff)] [&_.data-panel]:mb-4 [&_.table-wrap]:overflow-x-auto [&_table]:min-w-[720px] [&_tbody_tr:hover]:[background:color-mix(in_srgb,_var(--branch-accent)_5%,_var(--hover))] [&_.chart-surface]:p-[10px_4px_0] [&_.chart-legend]:flex [&_.chart-legend]:flex-wrap [&_.chart-legend]:gap-[15px] [&_.chart-legend]:p-[4px_6px_10px] [&_.chart-legend-item]:inline-flex [&_.chart-legend-item]:items-center [&_.chart-legend-item]:gap-[7px] [&_.chart-legend-item]:text-muted [&_.chart-legend-item]:text-[8.5px] [&_.chart-legend-item]:font-[680] later:[&_.legend-swatch]:inline-block [&_.legend-swatch]:w-[15px] [&_.legend-swatch]:h-[8px] [&_.legend-swatch]:rounded-[4px] [&_.legend-bar]:[background:#6687ff] later:[&_.legend-line]:h-[3px] later:[&_.legend-line]:rounded-[999px] [&_.legend-line]:[background:#32c997] [&_.chart-tooltip]:flex [&_.chart-tooltip]:flex-col [&_.chart-tooltip]:gap-1 [&_.chart-tooltip]:p-[9px_11px] [&_.chart-tooltip]:border [&_.chart-tooltip]:border-line-strong [&_.chart-tooltip]:rounded-[11px] [&_.chart-tooltip]:[background:color-mix(in_srgb,_var(--panel-2)_96%,_transparent)] [&_.chart-tooltip]:[box-shadow:var(--shadow-md)] [&_.chart-tooltip]:text-[9px] [&_.chart-tooltip]:text-text-secondary [&_.chart-tooltip]:pointer-events-none [&_.chart-tooltip_strong]:text-text [&_.chart-tooltip_strong]:text-[9.5px] [&_.chart-empty-note]:absolute [&_.chart-empty-note]:top-[8px] [&_.chart-empty-note]:right-[12px] [&_.chart-empty-note]:z-3 [&_.chart-empty-note]:p-[4px_11px] [&_.chart-empty-note]:[border:1px_dashed_color-mix(in_srgb,_var(--branch-accent)_42%,_var(--border))] [&_.chart-empty-note]:rounded-[999px] [&_.chart-empty-note]:[background:color-mix(in_srgb,_var(--panel)_90%,_#000_10%)] [&_.chart-empty-note]:text-muted [&_.chart-empty-note]:text-[9px] [&_.chart-empty-note]:font-[700] [&_.chart-empty-note]:tracking-[.04em] [&_.chart-empty-note]:pointer-events-none [&_.chart-empty-note]:whitespace-nowrap [&_.chart-caption]:m-0 [&_.chart-caption]:p-[6px_6px_2px] [&_.chart-caption]:text-[8.5px] [&_.chart-caption]:leading-[1.5] [&_.chart-caption]:text-muted [&_td_small]:block [&_td_small]:mt-[3px] [&_td_small]:text-muted [&_td_small]:text-[9px] [&_.branch-signout-button]:min-h-[40px] [&_.branch-signout-button]:inline-flex [&_.branch-signout-button]:items-center [&_.branch-signout-button]:justify-center [&_.branch-signout-button]:gap-2 [&_.branch-signout-button]:p-[0_18px] [&_.branch-signout-button]:border [&_.branch-signout-button]:border-transparent [&_.branch-signout-button]:rounded-[999px] [&_.branch-signout-button]:text-[#fff] [&_.branch-signout-button]:[background:linear-gradient(135deg,_var(--branch-accent),_color-mix(in_srgb,_var(--branch-accent)_72%,_#6d58ff))] [&_.branch-signout-button]:[box-shadow:0_10px_24px_color-mix(in_srgb,_var(--branch-accent)_24%,_transparent)] [&_.branch-signout-button]:text-[13px] [&_.branch-signout-button]:font-[760] [&_.branch-signout-button]:[transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&_.branch-signout-button:hover:not(:disabled)]:[transform:translateY(-2px)] [&_.branch-signout-button:hover:not(:disabled)]:[box-shadow:0_15px_30px_color-mix(in_srgb,_var(--branch-accent)_30%,_transparent)] [&_.branch-signout-button:hover:not(:disabled)]:[filter:saturate(1.1)] [&_.branch-readable-table]:text-[14px] [&_.branch-readable-table_td_strong]:text-[14px] min-h-[100vh] grid grid-cols-[280px_minmax(0,_1fr)] max-[761px]:later:block" style={{ '--branch-accent': accent }}>
      <aside className="sticky top-0 h-[100vh] flex flex-col overflow-y-auto [border-right:1px_solid_color-mix(in_srgb,_var(--branch-accent)_28%,_var(--border))] [background:color-mix(in_srgb,_var(--branch-accent)_4%,_var(--panel))] max-[761px]:later:static max-[761px]:later:h-auto max-[761px]:later:overflow-visible max-[761px]:later:border-r-0">
        <div className="p-[22px_20px_18px] [border-bottom:1px_solid_color-mix(in_srgb,_var(--branch-accent)_28%,_var(--border))] [&_strong]:block [&_strong]:text-text [&_strong]:text-[21px] [&_strong]:font-[800] [&_strong]:leading-[1.18] [&_strong]:[overflow-wrap:anywhere] [&_small]:block [&_small]:mt-[5px] [&_small]:text-text-secondary [&_small]:text-[13px] [&_small]:font-[700] [&_small]:[overflow-wrap:anywhere] max-[761px]:later:p-4 max-[761px]:later:[&_strong]:text-[18px]">
          <strong title={location?.brand?.name || undefined}>{place}</strong>
          <small>{ownerName}</small>
          {preview && <span className="inline-block mt-2 text-muted text-[11px] font-[700]">Admin read-only preview</span>}
        </div>
        {workspace && (
          <nav className="flex-[1_0_auto] m-0 p-[18px_14px] [&_button]:relative [&_button]:w-full [&_button]:min-h-[54px] [&_button]:flex [&_button]:items-center [&_button]:gap-3 [&_button]:p-[7px_12px] later-2:[&_button]:border later-2:[&_button]:border-transparent later-2:[&_button]:rounded-[14px] [&_button]:text-text-secondary [&_button]:[background:transparent] later-2:[&_button]:text-[14px] later-2:[&_button]:font-[700] [&_button]:text-left [&_button]:[transition:transform_.18s_ease,_color_.18s_ease,_border-color_.18s_ease,_background_.18s_ease] [&_button:hover]:text-text [&_button:hover]:[background:var(--hover)] [&_button:hover]:[transform:translateX(2px)] [&_button>svg]:w-[38px] [&_button>svg]:h-[38px] [&_button>svg]:flex-[0_0_auto] [&_button>svg]:p-[11px] [&_button>svg]:rounded-[12px] [&_button>svg]:text-text-secondary [&_button>svg]:[background:var(--surface-subtle)] [&_button.active]:text-text [&_button.active]:border-[color:color-mix(in_srgb,_var(--branch-accent)_23%,_var(--border))] later:[&_button.active]:[background:linear-gradient(120deg,_color-mix(in_srgb,_var(--branch-accent)_13%,_transparent),_color-mix(in_srgb,_var(--branch-accent)_4%,_transparent))] [&_button.active]:[box-shadow:inset_3px_0_var(--branch-accent),_inset_0_1px_0_color-mix(in_srgb,_#fff_4%,_transparent)] [&_button.active>svg]:text-[#fff] [&_button.active>svg]:[background:linear-gradient(135deg,_var(--branch-accent),_color-mix(in_srgb,_var(--branch-accent)_72%,_#6d58ff))] [&_button.active>svg]:[box-shadow:0_6px_15px_color-mix(in_srgb,_var(--branch-accent)_22%,_transparent)] max-[761px]:flex max-[761px]:gap-2 max-[761px]:overflow-x-auto max-[761px]:later:p-[10px_16px] max-[761px]:border-b max-[761px]:border-b-line max-[761px]:later:[&_button]:w-auto max-[761px]:[&_button]:flex-[0_0_auto] max-[761px]:[&_button]:whitespace-nowrap" aria-label="Branch portal modules">
            {navGroups.map((group, index) => (
              <div className="grid gap-2 max-[761px]:later:flex" key={group[0][0]}>
                {index > 0 && <hr className="w-full h-[1px] m-[10px_0] border-0 [background:color-mix(in_srgb,_var(--branch-accent)_28%,_var(--border))] max-[761px]:later:w-[1px] max-[761px]:later:h-auto max-[761px]:later:m-[4px_0]" />}
                {group.map(([id, Icon]) => (
                  <button
                    type="button"
                    key={id}
                    className={view === id ? 'active [&.branch-selector-card]:border-[color:color-mix(in_srgb,_var(--accent)_46%,_var(--border))] [&.branch-selector-card]:[background:linear-gradient(145deg,_color-mix(in_srgb,_var(--accent)_7%,_var(--panel)),_var(--panel))] [&.branch-selector-card]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--accent)_8%,_transparent),_var(--shadow-md)] [&.duration-preset]:text-accent-text [&.duration-preset]:border-[color:color-mix(in_srgb,_var(--accent)_42%,_transparent)] [&.duration-preset]:[background:var(--active)] [&.inventory-chip]:text-[#fff] [&.inventory-chip]:border-transparent [&.inventory-chip]:[background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [&.inventory-chip]:[box-shadow:0_8px_18px_color-mix(in_srgb,_var(--accent)_26%,_transparent)] [.ap-tabs_&.ap-tab]:[background:rgba(123,_136,_255,_.18)] [.ap-tabs_&.ap-tab]:text-[#aeb6ff] [.ap-tabs_&.ap-tab]:border-transparent [.ap-tabs_&.ap-tab]:[box-shadow:none]' : ''}
                    aria-current={view === id ? 'page' : undefined}
                    onClick={() => goTo(id)}
                  >
                    <Icon aria-hidden="true" /><span>{BRANCH_VIEWS[id].label}</span>
                  </button>
                ))}
              </div>
            ))}
          </nav>
        )}
        <div className="p-[18px_20px] [border-top:1px_solid_color-mix(in_srgb,_var(--branch-accent)_28%,_var(--border))] max-[761px]:later:p-[10px_16px] max-[761px]:later:border-t-0">
          {preview
            ? <button type="button" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)] branch-signout-button" onClick={() => navigate('/branches')}>Return to Branches</button>
            : <button type="button" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)] branch-signout-button" onClick={() => void handleSignOut()}><FaRightFromBracket aria-hidden="true" /> Sign out</button>}
        </div>
      </aside>

      <div className="min-w-0 flex flex-col">
        <header className="min-h-[84px] flex items-center p-[14px_28px] [border-bottom:1px_solid_color-mix(in_srgb,_var(--branch-accent)_28%,_var(--border))] [background:linear-gradient(90deg,_color-mix(in_srgb,_var(--branch-accent)_9%,_var(--panel)),_var(--panel))] max-[761px]:later:min-h-0 max-[761px]:later:p-[12px_16px]">
          <nav aria-label="Breadcrumb" className="[&_ol]:flex [&_ol]:flex-wrap [&_ol]:items-center [&_ol]:m-0 [&_ol]:p-0 [&_ol]:[list-style:none] [&_ol]:text-[18px] [&_ol]:font-[800] [&_li]:inline-flex [&_li]:items-center [&_li+li::before]:[content:'/'] [&_li+li::before]:m-[0_10px] [&_li+li::before]:text-muted [&_li+li::before]:font-[500] [&_a]:text-text-secondary [&_a]:[text-decoration:none] [&_a:hover]:text-[color:var(--branch-accent)] [&_a:hover]:[text-decoration:underline] [&_a:focus-visible]:[outline:2px_solid_var(--branch-accent)] [&_a:focus-visible]:[outline-offset:3px] [&_a:focus-visible]:rounded-[4px] later-4:[&_[aria-current]]:text-text max-[761px]:later:[&_ol]:text-[14px]">
            <ol>
              {crumbs.map((crumb) => (
                <li key={crumb.label}>
                  {crumb.view
                    ? <Link to={{ search: viewSearch(crumb.view) }}>{crumb.label}</Link>
                    : <span aria-current="page">{crumb.label}</span>}
                </li>
              ))}
            </ol>
          </nav>
        </header>

        <main className="flex-1 min-w-0 p-[22px_28px] max-[761px]:later:p-4">
          <Notice type="error">{error}</Notice>
          {loading && !workspace ? <LoadingState label="Loading your branch workspace…" /> : !workspace ? (
            <section className="data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65]">
              <EmptyState label="Branch workspace unavailable" detail="Your account must be assigned to exactly one active branch. Contact an administrator." />
            </section>
          ) : (
            <div className="branch-portal-module min-w-0 [&>.data-panel]:p-[18px] [&_.data-panel>h2]:m-[0_0_8px] [&_.data-panel>h2]:text-text [&_.data-panel>h2]:text-[14px] [&_.data-panel>h2]:tracking-[-.02em] later:[&_.data-panel>p]:m-[0_0_14px] [&_.data-panel>p]:text-muted later:[&_.data-panel>p]:text-[10px] [&_.data-panel>p]:leading-[1.65] [&_.branch-action-form_input]:text-text [&_.branch-action-form_input]:border [&_.branch-action-form_input]:border-input-line [&_.branch-action-form_input]:rounded-[11px] [&_.branch-action-form_input]:[background-color:var(--input-bg)] [&_.branch-action-form_input]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease,_background-color_.18s_ease] [&_.branch-action-form_select]:text-text [&_.branch-action-form_select]:border [&_.branch-action-form_select]:border-input-line [&_.branch-action-form_select]:rounded-[11px] [&_.branch-action-form_select]:[background-color:var(--input-bg)] [&_.branch-action-form_select]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease,_background-color_.18s_ease] [&_.branch-action-form_textarea]:text-text [&_.branch-action-form_textarea]:border [&_.branch-action-form_textarea]:border-input-line [&_.branch-action-form_textarea]:rounded-[11px] [&_.branch-action-form_textarea]:[background-color:var(--input-bg)] [&_.branch-action-form_textarea]:[transition:border-color_.18s_ease,_box-shadow_.18s_ease,_background-color_.18s_ease] [&_.branch-action-form_input::placeholder]:text-placeholder [&_.branch-action-form_textarea::placeholder]:text-placeholder [&_.branch-action-form_input:focus]:[outline:0] [&_.branch-action-form_input:focus]:border-[color:var(--branch-accent)] [&_.branch-action-form_input:focus]:[background-color:var(--input-focus-bg)] [&_.branch-action-form_input:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--branch-accent)_17%,_transparent)] [&_.branch-action-form_select:focus]:[outline:0] [&_.branch-action-form_select:focus]:border-[color:var(--branch-accent)] [&_.branch-action-form_select:focus]:[background-color:var(--input-focus-bg)] [&_.branch-action-form_select:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--branch-accent)_17%,_transparent)] [&_.branch-action-form_textarea:focus]:[outline:0] [&_.branch-action-form_textarea:focus]:border-[color:var(--branch-accent)] [&_.branch-action-form_textarea:focus]:[background-color:var(--input-focus-bg)] [&_.branch-action-form_textarea:focus]:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--branch-accent)_17%,_transparent)] [&_.branch-action-form>button[type='submit']]:min-h-[42px] [&_.branch-action-form>button[type='submit']]:[justify-self:start] [&_.branch-action-form>button[type='submit']]:p-[0_16px] [&_.branch-action-form>button[type='submit']]:border [&_.branch-action-form>button[type='submit']]:border-transparent [&_.branch-action-form>button[type='submit']]:rounded-[12px] [&_.branch-action-form>button[type='submit']]:text-[#fff] [&_.branch-action-form>button[type='submit']]:[background:linear-gradient(135deg,_var(--branch-accent),_color-mix(in_srgb,_var(--branch-accent)_70%,_#695cff))] [&_.branch-action-form>button[type='submit']]:[box-shadow:0_10px_24px_color-mix(in_srgb,_var(--branch-accent)_22%,_transparent)] [&_.branch-action-form>button[type='submit']]:text-[10px] [&_.branch-action-form>button[type='submit']]:font-[780] [&_.branch-action-form>button[type='submit']]:[transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&_.branch-action-form>button[type='submit']:hover:not(:disabled)]:[transform:translateY(-2px)] [&_.branch-action-form>button[type='submit']:hover:not(:disabled)]:[box-shadow:0_14px_28px_color-mix(in_srgb,_var(--branch-accent)_29%,_transparent)] [&_.branch-action-form>button[type='submit']:hover:not(:disabled)]:[filter:saturate(1.08)] [.branch-portal-page_&>.branch-portal-financial]:min-w-0">
              {view === 'dashboard' && <BranchDashboardPanel branchQuery={branchQuery} preview={preview} role={role} onViewAll={() => goTo('transactions')} />}
              {view === 'transactions' && <BranchTransactionsPanel branchQuery={branchQuery} />}
              {view === 'inventory' && <BranchRawMaterialsPanel branchQuery={branchQuery} preview={preview} />}
              {view === 'products' && <BranchProductsPanel branchQuery={branchQuery} preview={preview} role={role} />}
              {view === 'production' && <BranchProductionPanel branchQuery={branchQuery} preview={preview} onGoToSupply={() => goTo('supply')} />}
              {view === 'supply' && <BranchSupplyPanel branchQuery={branchQuery} location={location} preview={preview} />}
              <p className="[.branch-portal-module_&]:mt-2 text-muted text-[9px] text-right">{BRANCH_VIEWS[view].label} · live refresh every 15 seconds</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default BranchPortal;

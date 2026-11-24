// The eleven demo branches. Nine reuse the existing franchisee accounts (renamed, history rebuilt);
// Ceejay's and John Rey's keep their accounts and applicant records and get a branch history.
export interface ForecastShape {
  /** A one-day production spike (an event), flagged by the dips-and-spikes check. */
  spikeDay?: string;
  /** Production change over the last 7 days, e.g. 0.3 = +30 %. */
  trend?: number;
  closures?: [string, string, string][];
  /** [Monday, reason]: a manually excluded week, with lighter production. */
  excludedWeek?: [string, string];
  /** No physical count after this day (the stale-count card). */
  staleAfter?: string;
  /** Perishable: max cover days on the first matching material. */
  maxCover?: RegExp;
  /** The first matching material loses its warehouse link (the Network view's unmapped list). */
  unmapped?: RegExp;
  /** Counted to zero on the last day (No stock). */
  outOf?: RegExp;
  /** Not reordered after the freeze: ends with little cover. */
  lowCover?: RegExp[];
  /** A large delivery in the last week: Overstocked. */
  overstock?: RegExp;
}
export interface BranchSpec {
  email: string; name: string; code: string; owner: string | null; province: string; city: string; barangay: string; open: string;
  /** Requests created on or after this day stay open (not delivered); openStates decides each one's status. */
  freezeFrom: string;
  openStates: string[];
  /** Special requests outside the restock cycle: rejected, cancelled, returned, draft, discrepancy, partial with backorder… */
  extras: string[];
  forecast: ForecastShape;
  /** Speed of a core product (pieces a day relative to the brand's base). */
  scale: number;
  /** Copies the materials and recipes of this branch (by email) when the branch has none. */
  cloneFrom?: string;
}

export const BRANCHES: BranchSpec[] = [
  {
    email: 'franchisee@franchisetitan.local', name: 'Kkopi Las Piñas City – Pamplona Uno', code: 'KK-LPC-01', owner: 'Maria Teresa Lim',
    province: 'NCR', city: 'Las Piñas', barangay: 'Pamplona Uno', open: '2025-06-16', freezeFrom: '2026-11-22', scale: 1.15,
    openStates: ['waiting_logistics'], extras: ['partial_backorder', 'cancelled'],
    forecast: { maxCover: /fresh milk/i, lowCover: [/okinawa|brown sugar/i], overstock: /cup sleeve|straw/i,
      closures: [['2025-12-25', '2025-12-25', 'Christmas Day'], ['2026-01-01', '2026-01-01', "New Year's Day"]] },
  },
  {
    email: 'branch1@herald.local', name: 'Kkopi Bacoor – Molino III', code: 'KK-BAC-01', owner: 'Rafael Dizon',
    province: 'Cavite', city: 'Bacoor', barangay: 'Molino III', open: '2026-11-14', freezeFrom: '2026-11-24', scale: 0.8,
    openStates: ['submitted'], extras: [], cloneFrom: 'kkopi@demo.herald.local', forecast: {},
  },
  {
    email: 'branch2@herald.local', name: 'GoDo Quezon City – Teachers Village East', code: 'GD-QZN-01', owner: 'Paolo Mercado',
    province: 'NCR', city: 'Quezon City', barangay: 'Teachers Village East', open: '2025-08-18', freezeFrom: '2026-11-20', scale: 1.1,
    openStates: ['preparing'], extras: ['rejected'],
    forecast: { closures: [['2026-11-01', '2026-11-02', "All Saints' and All Souls' Day"], ['2025-12-24', '2025-12-25', 'Christmas break']], lowCover: [/mango/i], overstock: /cup|lid/i },
  },
  {
    email: 'branch3@herald.local', name: 'Daily Dash Pasig City – Kapitolyo', code: 'DD-PSG-01', owner: 'Mark Anthony Cruz',
    province: 'NCR', city: 'Pasig', barangay: 'Kapitolyo', open: '2025-10-06', freezeFrom: '2026-11-18', scale: 1.05,
    openStates: ['dispatched_pod_ready'], extras: ['discrepancy_review'],
    forecast: { excludedWeek: ['2026-11-02', 'Mall renovation: shortened hours all week'], lowCover: [/espresso/i], overstock: /stirrer|sleeve/i },
  },
  {
    email: 'branch4@herald.local', name: 'La Pasta Marikina City – Concepcion Uno', code: 'LP-MRK-01', owner: 'Dennis Aquino',
    province: 'NCR', city: 'Marikina', barangay: 'Concepcion Uno', open: '2025-12-08', freezeFrom: '2026-11-20', scale: 1,
    openStates: ['on_hold'], extras: ['returned'],
    forecast: { trend: -0.25, outOf: /parmesan/i, lowCover: [/bacon|ground beef/i], overstock: /fork|spoon/i },
  },
  {
    email: 'kkopi@demo.herald.local', name: 'Kkopi Makati City – Poblacion', code: 'KK-MKT-01', owner: 'Angela Reyes',
    province: 'NCR', city: 'Makati', barangay: 'Poblacion', open: '2026-02-09', freezeFrom: '2026-11-18', scale: 1.25,
    openStates: ['dispatched_pod_ready'], extras: ['completed_with_discrepancy'],
    forecast: { spikeDay: '2026-11-12', lowCover: [/matcha/i], overstock: /dome lid/i },
  },
  {
    email: 'godo@demo.herald.local', name: 'GoDo San Pedro – Landayan', code: 'GD-SPL-01', owner: 'Christine Bautista',
    province: 'Laguna', city: 'San Pedro', barangay: 'Landayan', open: '2026-04-13', freezeFrom: '2026-11-19', scale: 0.95,
    openStates: ['scheduled_date_change', 'delivered_unconfirmed'], extras: [],
    forecast: { trend: 0.3, maxCover: /cream cheese|avocado/i },
  },
  {
    email: 'lapasta@demo.herald.local', name: 'La Pasta Antipolo City – San Roque', code: 'LP-ANT-01', owner: 'Katrina Flores',
    province: 'Rizal', city: 'Antipolo', barangay: 'San Roque', open: '2026-08-17', freezeFrom: '2026-11-20', scale: 0.9,
    openStates: ['preparing_shortage'], extras: ['draft'],
    forecast: { unmapped: /lemon|calamansi/i, lowCover: [/pesto/i] },
  },
  {
    email: 'dailydash@demo.herald.local', name: 'Daily Dash Taguig City – Fort Bonifacio', code: 'DD-TGG-01', owner: 'Jasmine Villanueva',
    province: 'NCR', city: 'Taguig', barangay: 'Fort Bonifacio', open: '2026-06-15', freezeFrom: '2026-11-17', scale: 1.2,
    openStates: ['dispatched_overdue', 'under_review'], extras: ['rejected'],
    forecast: { staleAfter: '2026-11-09', overstock: /hot cup/i },
  },
  {
    email: 'cj@gmail.com', name: 'Daily Dash Las Piñas City – Talon Tres', code: 'DD-LPC-01', owner: null,
    province: 'NCR', city: 'Las Piñas', barangay: 'Talon Tres', open: '2026-11-04', freezeFrom: '2026-11-23', scale: 0.9,
    openStates: ['waiting_logistics'], extras: ['cancelled'], forecast: { lowCover: [/caramel/i] },
  },
  {
    email: 'johnreycarillo@gmail.com', name: 'Daily Dash Muntinlupa City – Alabang', code: 'DD-MNT-01', owner: null,
    province: 'NCR', city: 'Muntinlupa', barangay: 'Alabang', open: '2026-11-05', freezeFrom: '2026-11-21', scale: 0.85,
    openStates: ['scheduled'], extras: [], forecast: {},
  },
];

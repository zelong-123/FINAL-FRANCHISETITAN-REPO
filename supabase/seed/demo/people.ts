// Inquiries and applicants of the demo. Days are 2026 unless written otherwise. 'S' = Sales User,
// 'H' = Herald Sales. Every scenario follows the pipeline rules (see applicants.ts).
export type BrandKey = 'kk' | 'gd' | 'dd' | 'lp';
export interface Person {
  first: string; last: string; brand: BrandKey; source: string; sales: 'S' | 'H'; city: string; province: string; barangay: string;
  inquiry: string; convert?: string; scenario: string;
  /** The brand chosen at Orientation/Tasting when it differs from the inquiry. */
  chose?: BrandKey;
  /** For the active franchisees: the branch (by its franchisee email). */
  branch?: string;
  /** Schedule details: [day, 'HH:MM', minutes]. */
  ot?: [string, string, number]; training?: [string, string, number];
}

export const BRAND_NAMES: Record<BrandKey, string> = { kk: 'Kkopi', gd: 'GoDo', dd: 'Daily Dash', lp: 'La Pasta' };

export const ACTIVE: Person[] = [
  { first: 'Maria Teresa', last: 'Lim', brand: 'kk', source: 'facebook', sales: 'S', city: 'Las Piñas', province: 'NCR', barangay: 'Pamplona Uno', inquiry: '2025-03-10', convert: '2025-03-14', scenario: 'active', branch: 'franchisee@franchisetitan.local' },
  { first: 'Paolo', last: 'Mercado', brand: 'gd', source: 'referral', sales: 'S', city: 'Quezon City', province: 'NCR', barangay: 'Teachers Village East', inquiry: '2025-05-05', convert: '2025-05-09', scenario: 'active', branch: 'branch2@herald.local' },
  { first: 'Mark Anthony', last: 'Cruz', brand: 'dd', source: 'walk_in', sales: 'H', city: 'Pasig', province: 'NCR', barangay: 'Kapitolyo', inquiry: '2025-07-07', convert: '2025-07-11', scenario: 'active', branch: 'branch3@herald.local' },
  { first: 'Dennis', last: 'Aquino', brand: 'lp', source: 'gmail', sales: 'S', city: 'Marikina', province: 'NCR', barangay: 'Concepcion Uno', inquiry: '2025-09-01', convert: '2025-09-05', scenario: 'active', branch: 'branch4@herald.local' },
  { first: 'Angela', last: 'Reyes', brand: 'kk', source: 'viber', sales: 'H', city: 'Makati', province: 'NCR', barangay: 'Poblacion', inquiry: '2025-11-03', convert: '2025-11-07', scenario: 'active', branch: 'kkopi@demo.herald.local' },
  { first: 'Christine', last: 'Bautista', brand: 'gd', source: 'facebook', sales: 'S', city: 'San Pedro', province: 'Laguna', barangay: 'Landayan', inquiry: '2026-01-12', convert: '2026-01-16', scenario: 'active', branch: 'godo@demo.herald.local' },
  { first: 'Jasmine', last: 'Villanueva', brand: 'dd', source: 'referral', sales: 'H', city: 'Taguig', province: 'NCR', barangay: 'Fort Bonifacio', inquiry: '2026-03-09', convert: '2026-03-13', scenario: 'active', branch: 'dailydash@demo.herald.local' },
  { first: 'Katrina', last: 'Flores', brand: 'lp', source: 'facebook', sales: 'S', city: 'Antipolo', province: 'Rizal', barangay: 'San Roque', inquiry: '2026-05-11', convert: '2026-05-15', scenario: 'active', branch: 'lapasta@demo.herald.local' },
  { first: 'Rafael', last: 'Dizon', brand: 'kk', source: 'walk_in', sales: 'H', city: 'Bacoor', province: 'Cavite', barangay: 'Molino III', inquiry: '2026-08-17', convert: '2026-08-21', scenario: 'active', branch: 'branch1@herald.local' },
];

export const PIPELINE: Person[] = [
  // Qualification (Converted)
  { first: 'Joshua', last: 'Ramos', brand: 'kk', source: 'facebook', sales: 'S', city: 'Parañaque', province: 'NCR', barangay: 'BF Homes', inquiry: '2026-11-12', convert: '2026-11-17', scenario: 'conv_missing' },
  { first: 'Patricia', last: 'Gonzales', brand: 'dd', source: 'viber', sales: 'H', city: 'Mandaluyong', province: 'NCR', barangay: 'Plainview', inquiry: '2026-11-10', convert: '2026-11-16', scenario: 'conv_waiting' },
  { first: 'Ronald', last: 'Soriano', brand: 'gd', source: 'walk_in', sales: 'S', city: 'Caloocan', province: 'NCR', barangay: 'Bagong Silang', inquiry: '2026-11-09', convert: '2026-11-13', scenario: 'conv_returned' },
  { first: 'Elaine', last: 'Navarro', brand: 'lp', source: 'gmail', sales: 'S', city: 'Imus', province: 'Cavite', barangay: 'Anabu I-A', inquiry: '2026-11-05', convert: '2026-11-10', scenario: 'conv_ready' },
  { first: 'Gerald', last: 'Pascual', brand: 'kk', source: 'referral', sales: 'H', city: 'Valenzuela', province: 'NCR', barangay: 'Malinta', inquiry: '2026-11-03', convert: '2026-11-06', scenario: 'qualified_ready' },
  // Scheduling
  { first: 'Lorna', last: 'Castillo', brand: 'dd', source: 'facebook', sales: 'S', city: 'Muntinlupa', province: 'NCR', barangay: 'Tunasan', inquiry: '2026-11-02', convert: '2026-11-05', scenario: 'sched_none' },
  { first: 'Ramon', last: 'Del Rosario', brand: 'gd', source: 'viber', sales: 'H', city: 'Quezon City', province: 'NCR', barangay: 'Commonwealth', inquiry: '2026-10-26', convert: '2026-10-29', scenario: 'overdue_noschedule' },
  { first: 'Cristina', last: 'Manalo', brand: 'kk', source: 'gmail', sales: 'S', city: 'Pasay', province: 'NCR', barangay: 'Malibay', inquiry: '2026-10-26', convert: '2026-10-30', scenario: 'overdue_past', ot: ['2026-11-13', '09:00', 120] },
  { first: 'Victor', last: 'Hernandez', brand: 'lp', source: 'referral', sales: 'S', city: 'San Juan', province: 'NCR', barangay: 'Greenhills', inquiry: '2026-10-28', convert: '2026-11-02', scenario: 'noshow', ot: ['2026-11-18', '09:00', 120] },
  { first: 'Grace', last: 'Ocampo', brand: 'dd', source: 'facebook', sales: 'H', city: 'Dasmariñas', province: 'Cavite', barangay: 'Salitran', inquiry: '2026-10-29', convert: '2026-11-03', scenario: 'noshow', ot: ['2026-11-20', '13:00', 120] },
  { first: 'Arnold', last: 'Tan', brand: 'kk', source: 'walk_in', sales: 'S', city: 'Manila', province: 'NCR', barangay: 'Sampaloc', inquiry: '2026-11-02', convert: '2026-11-06', scenario: 'ot_not_submitted', ot: ['2026-11-20', '09:00', 120] },
  { first: 'Bea', last: 'Santiago', brand: 'gd', source: 'facebook', sales: 'H', city: 'Makati', province: 'NCR', barangay: 'San Antonio', inquiry: '2026-11-04', convert: '2026-11-09', scenario: 'ready_today', ot: ['2026-11-24', '09:00', 120] },
  { first: 'Carlo', last: 'Mendoza', brand: 'dd', source: 'viber', sales: 'H', city: 'Taguig', province: 'NCR', barangay: 'Ususan', inquiry: '2026-11-05', convert: '2026-11-10', scenario: 'future', ot: ['2026-11-25', '09:00', 120] },
  { first: 'Diana', last: 'Rivera', brand: 'lp', source: 'gmail', sales: 'S', city: 'Pasig', province: 'NCR', barangay: 'Ugong', inquiry: '2026-11-06', convert: '2026-11-11', scenario: 'future', ot: ['2026-11-26', '09:00', 120] },
  { first: 'Edward', last: 'Bautista', brand: 'kk', source: 'referral', sales: 'S', city: 'Las Piñas', province: 'NCR', barangay: 'Almanza Uno', inquiry: '2026-11-06', convert: '2026-11-11', scenario: 'future', ot: ['2026-11-26', '09:00', 120] },
  { first: 'Faith', last: 'Valdez', brand: 'gd', source: 'facebook', sales: 'S', city: 'Bacoor', province: 'Cavite', barangay: 'Niog', inquiry: '2026-11-09', convert: '2026-11-12', scenario: 'future', ot: ['2026-11-26', '09:00', 120] },
  { first: 'Gilbert', last: 'Aguilar', brand: 'dd', source: 'walk_in', sales: 'H', city: 'Quezon City', province: 'NCR', barangay: 'Cubao', inquiry: '2026-11-09', convert: '2026-11-13', scenario: 'future', ot: ['2026-11-27', '09:00', 120] },
  { first: 'Hazel', last: 'Morales', brand: 'kk', source: 'viber', sales: 'S', city: 'Parañaque', province: 'NCR', barangay: 'Baclaran', inquiry: '2026-10-19', convert: '2026-10-23', scenario: 'training_future', ot: ['2026-11-10', '09:00', 120], training: ['2026-11-27', '14:00', 180] },
  { first: 'Ivan', last: 'Robles', brand: 'lp', source: 'gmail', sales: 'H', city: 'Marikina', province: 'NCR', barangay: 'Parang', inquiry: '2026-11-10', convert: '2026-11-13', scenario: 'future', ot: ['2026-11-30', '09:00', 120] },
  { first: 'Jenny', last: 'Lopez', brand: 'dd', source: 'facebook', sales: 'H', city: 'Pasay', province: 'NCR', barangay: 'San Isidro', inquiry: '2026-11-10', convert: '2026-11-16', scenario: 'future', ot: ['2026-11-30', '12:00', 120] },
  { first: 'Kevin', last: 'Torres', brand: 'gd', source: 'referral', sales: 'S', city: 'Caloocan', province: 'NCR', barangay: 'Grace Park East', inquiry: '2026-11-11', convert: '2026-11-16', scenario: 'future', ot: ['2026-12-01', '09:00', 120] },
  { first: 'Lyka', last: 'Domingo', brand: 'kk', source: 'facebook', sales: 'S', city: 'Valenzuela', province: 'NCR', barangay: 'Karuhatan', inquiry: '2026-11-11', convert: '2026-11-17', scenario: 'future', ot: ['2026-12-01', '09:00', 120] },
  { first: 'Miguel', last: 'Fernandez', brand: 'dd', source: 'viber', sales: 'S', city: 'Malabon', province: 'NCR', barangay: 'Tinajeros', inquiry: '2026-11-12', convert: '2026-11-17', scenario: 'future', ot: ['2026-12-01', '09:00', 120] },
  { first: 'Nicole', last: 'Garcia', brand: 'lp', source: 'gmail', sales: 'S', city: 'Navotas', province: 'NCR', barangay: 'San Jose', inquiry: '2026-11-12', convert: '2026-11-18', scenario: 'future', ot: ['2026-12-01', '09:00', 120] },
  { first: 'Oscar', last: 'Reyes', brand: 'gd', source: 'walk_in', sales: 'S', city: 'Manila', province: 'NCR', barangay: 'Tondo', inquiry: '2026-11-13', convert: '2026-11-18', scenario: 'future', ot: ['2026-12-01', '09:00', 120] },
  { first: 'Pamela', last: 'Cruz', brand: 'kk', source: 'facebook', sales: 'H', city: 'Quezon City', province: 'NCR', barangay: 'Kamuning', inquiry: '2026-10-30', convert: '2026-11-04', scenario: 'ot_waiting_verify', ot: ['2026-11-19', '09:00', 120], chose: 'dd' },
  { first: 'Rico', last: 'Salazar', brand: 'gd', source: 'referral', sales: 'H', city: 'Imus', province: 'Cavite', barangay: 'Bucandala I', inquiry: '2026-10-27', convert: '2026-10-30', scenario: 'ot_returned', ot: ['2026-11-17', '13:00', 120] },
  { first: 'Sheila', last: 'Uy', brand: 'dd', source: 'gmail', sales: 'H', city: 'Mandaluyong', province: 'NCR', barangay: 'Wack-Wack Greenhills', inquiry: '2026-10-22', convert: '2026-10-27', scenario: 'ot_verified', ot: ['2026-11-12', '09:00', 120] },
  { first: 'Tristan', last: 'Lim', brand: 'lp', source: 'facebook', sales: 'S', city: 'Pasig', province: 'NCR', barangay: 'San Antonio', inquiry: '2026-10-14', convert: '2026-10-19', scenario: 'training_waiting', ot: ['2026-11-05', '09:00', 120], training: ['2026-11-18', '14:00', 180] },
  { first: 'Ursula', last: 'Diaz', brand: 'kk', source: 'viber', sales: 'H', city: 'Makati', province: 'NCR', barangay: 'Bel-Air', inquiry: '2026-10-06', convert: '2026-10-09', scenario: 'both_done', ot: ['2026-10-26', '09:00', 120], training: ['2026-11-09', '14:00', 180] },
  { first: 'Vince', last: 'Ortega', brand: 'gd', source: 'facebook', sales: 'S', city: 'Antipolo', province: 'Rizal', barangay: 'Dela Paz', inquiry: '2026-10-20', convert: '2026-10-23', scenario: 'on_hold' },
  { first: 'Wendy', last: 'Chua', brand: 'dd', source: 'walk_in', sales: 'H', city: 'Manila', province: 'NCR', barangay: 'Binondo', inquiry: '2026-10-20', convert: '2026-10-26', scenario: 'stalled' },
  // LOI Submission
  { first: 'Xavier', last: 'Jimenez', brand: 'kk', source: 'referral', sales: 'S', city: 'Quezon City', province: 'NCR', barangay: 'Diliman', inquiry: '2026-09-21', convert: '2026-09-25', scenario: 'loi_empty' },
  { first: 'Yvonne', last: 'Panganiban', brand: 'lp', source: 'facebook', sales: 'H', city: 'Cainta', province: 'Rizal', barangay: 'San Isidro', inquiry: '2026-09-28', convert: '2026-10-02', scenario: 'loi_empty' },
  { first: 'Zaldy', last: 'Ferrer', brand: 'gd', source: 'gmail', sales: 'S', city: 'Biñan', province: 'Laguna', barangay: 'Canlalay', inquiry: '2026-09-14', convert: '2026-09-18', scenario: 'loi_site_waiting' },
  { first: 'Abigail', last: 'Santos', brand: 'dd', source: 'viber', sales: 'H', city: 'Las Piñas', province: 'NCR', barangay: 'Talon Uno', inquiry: '2026-09-15', convert: '2026-09-18', scenario: 'loi_returned' },
  // Payment Record
  { first: 'Benedict', last: 'Rosales', brand: 'kk', source: 'facebook', sales: 'S', city: 'Pasig', province: 'NCR', barangay: 'Rosario', inquiry: '2026-08-24', convert: '2026-08-28', scenario: 'pay_one_of_two' },
  { first: 'Camille', last: 'Ilagan', brand: 'gd', source: 'referral', sales: 'H', city: 'Santa Rosa', province: 'Laguna', barangay: 'Balibago', inquiry: '2026-08-31', convert: '2026-09-04', scenario: 'pay_none_rejected' },
  { first: 'Darwin', last: 'Mallari', brand: 'lp', source: 'walk_in', sales: 'S', city: 'Quezon City', province: 'NCR', barangay: 'Novaliches Proper', inquiry: '2026-09-01', convert: '2026-09-04', scenario: 'pay_none' },
  { first: 'Erika', last: 'Gutierrez', brand: 'dd', source: 'facebook', sales: 'S', city: 'General Trias', province: 'Cavite', barangay: 'Manggahan', inquiry: '2026-09-07', convert: '2026-09-11', scenario: 'pay_not_set' },
  { first: 'Francis', last: 'Leonardo', brand: 'kk', source: 'gmail', sales: 'H', city: 'Taguig', province: 'NCR', barangay: 'Western Bicutan', inquiry: '2026-08-17', convert: '2026-08-21', scenario: 'pay_waiting_verify' },
  // For Approval, Approved
  { first: 'Gemma', last: 'Velasco', brand: 'gd', source: 'referral', sales: 'S', city: 'Mandaluyong', province: 'NCR', barangay: 'Highway Hills', inquiry: '2026-08-03', convert: '2026-08-07', scenario: 'for_approval' },
  { first: 'Henry', last: 'Agustin', brand: 'dd', source: 'facebook', sales: 'H', city: 'Calamba', province: 'Laguna', barangay: 'Real', inquiry: '2026-08-10', convert: '2026-08-14', scenario: 'for_approval' },
  { first: 'Irene', last: 'Bernardo', brand: 'lp', source: 'viber', sales: 'S', city: 'Quezon City', province: 'NCR', barangay: 'Loyola Heights', inquiry: '2026-07-13', convert: '2026-07-17', scenario: 'approved_agreement_waiting' },
  { first: 'Jerome', last: 'Castro', brand: 'kk', source: 'facebook', sales: 'H', city: 'Malolos', province: 'Bulacan', barangay: 'Santo Rosario', inquiry: '2026-07-20', convert: '2026-07-24', scenario: 'approved_ready' },
  { first: 'Karen', last: 'Dela Paz', brand: 'gd', source: 'gmail', sales: 'S', city: 'Meycauayan', province: 'Bulacan', barangay: 'Malhacan', inquiry: '2026-07-27', convert: '2026-07-31', scenario: 'approved_no_agreement' },
  // Rejected and archived (two in October, two in November)
  { first: 'Leo', last: 'Manansala', brand: 'dd', source: 'facebook', sales: 'S', city: 'Pasig', province: 'NCR', barangay: 'Caniogan', inquiry: '2026-09-21', convert: '2026-09-24', scenario: 'rejected:2026-10-12' },
  { first: 'Mylene', last: 'Ramos', brand: 'lp', source: 'walk_in', sales: 'H', city: 'Manila', province: 'NCR', barangay: 'Malate', inquiry: '2026-09-28', convert: '2026-10-01', scenario: 'rejected:2026-10-26' },
  { first: 'Noel', last: 'Aquino', brand: 'kk', source: 'gmail', sales: 'S', city: 'Quezon City', province: 'NCR', barangay: 'Fairview', inquiry: '2026-10-19', convert: '2026-10-22', scenario: 'rejected:2026-11-10' },
  { first: 'Olivia', last: 'Santos', brand: 'gd', source: 'viber', sales: 'H', city: 'Makati', province: 'NCR', barangay: 'Pio del Pilar', inquiry: '2026-10-26', convert: '2026-10-29', scenario: 'rejected:2026-11-19' },
];

export interface Lead extends Person { status: string; followUps?: number; duplicateOf?: string; reason?: string }

/** Leads still in Marketing's hands (not converted). */
export const LEADS: Lead[] = [
  { first: 'Andrea', last: 'Villamor', brand: 'kk', source: 'facebook', sales: 'S', city: 'Quezon City', province: 'NCR', barangay: 'Batasan Hills', inquiry: '2026-11-24', scenario: 'lead', status: 'new' },
  { first: 'Benjie', last: 'Saldana', brand: 'dd', source: 'walk_in', sales: 'S', city: 'Pasig', province: 'NCR', barangay: 'Manggahan', inquiry: '2026-11-23', scenario: 'lead', status: 'new' },
  { first: 'Clarissa', last: 'Yap', brand: 'lp', source: 'gmail', sales: 'S', city: 'Santa Rosa', province: 'Laguna', barangay: 'Tagapo', inquiry: '2026-11-20', scenario: 'lead', status: 'new' },
  { first: 'Dominic', last: 'Lacson', brand: 'gd', source: 'viber', sales: 'S', city: 'Bacolod', province: 'Negros Occidental', barangay: 'Mandalagan', inquiry: '2026-11-11', scenario: 'lead', status: 'new' },
  { first: 'Eunice', last: 'Pineda', brand: 'dd', source: 'referral', sales: 'S', city: 'Tarlac City', province: 'Tarlac', barangay: 'San Vicente', inquiry: '2026-11-18', scenario: 'lead', status: 'contacted', followUps: 1 },
  { first: 'Ferdinand', last: 'Go', brand: 'kk', source: 'facebook', sales: 'S', city: 'Malolos', province: 'Bulacan', barangay: 'Longos', inquiry: '2026-11-16', scenario: 'lead', status: 'contacted', followUps: 2 },
  { first: 'Glenda', last: 'Ventura', brand: 'gd', source: 'gmail', sales: 'S', city: 'Batangas City', province: 'Batangas', barangay: 'Kumintang Ibaba', inquiry: '2026-11-04', scenario: 'lead', status: 'contacted', followUps: 1 },
  { first: 'Harold', last: 'Sison', brand: 'lp', source: 'viber', sales: 'S', city: 'San Fernando', province: 'Pampanga', barangay: 'Dolores', inquiry: '2026-11-13', scenario: 'lead', status: 'new' },
  { first: 'Isabel', last: 'Tolentino', brand: 'dd', source: 'facebook', sales: 'S', city: 'Antipolo', province: 'Rizal', barangay: 'Mayamot', inquiry: '2026-11-19', scenario: 'lead', status: 'new', duplicateOf: 'Yvonne Panganiban' },
  { first: 'Jomar', last: 'Bonifacio', brand: 'kk', source: 'walk_in', sales: 'S', city: 'Lipa', province: 'Batangas', barangay: 'Marawoy', inquiry: '2026-11-21', scenario: 'lead', status: 'contacted', followUps: 1 },
  { first: 'Kristine', last: 'Mercado', brand: 'gd', source: 'referral', sales: 'S', city: 'Calamba', province: 'Laguna', barangay: 'Parian', inquiry: '2026-11-17', scenario: 'lead', status: 'endorsed' },
  { first: 'Lawrence', last: 'Ong', brand: 'dd', source: 'facebook', sales: 'S', city: 'Makati', province: 'NCR', barangay: 'Guadalupe Nuevo', inquiry: '2026-11-19', scenario: 'lead', status: 'endorsed' },
  { first: 'Marites', last: 'Galang', brand: 'lp', source: 'gmail', sales: 'S', city: 'Muntinlupa', province: 'NCR', barangay: 'Putatan', inquiry: '2026-11-20', scenario: 'lead', status: 'endorsed' },
  { first: 'Nestor', last: 'Pangilinan', brand: 'kk', source: 'facebook', sales: 'S', city: 'Olongapo', province: 'Zambales', barangay: 'Barretto', inquiry: '2026-10-27', scenario: 'lead', status: 'rejected', reason: 'Proposed area is outside the current delivery coverage of the Central Warehouse.' },
  { first: 'Ofelia', last: 'Mariano', brand: 'gd', source: 'viber', sales: 'S', city: 'Cabanatuan', province: 'Nueva Ecija', barangay: 'Sumacab Este', inquiry: '2026-11-03', scenario: 'lead', status: 'rejected', reason: 'Declared budget is below the minimum franchise package.' },
];

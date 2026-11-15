// Orientation/Tasting and Training sessions and activities that have no handler get the assigned
// Sales user of their applicant(s), so the capacity, the 1-hour buffer and the handler rules apply.
// Rows whose applicant has no assigned Sales user (or whose applicants have different ones) are
// only reported. Every change is logged in audit_logs.
//
//   node --no-warnings supabase/scripts/fill_missing_handlers.ts --dry-run
//   node --no-warnings supabase/scripts/fill_missing_handlers.ts --apply
import type { Db, Row } from '../functions/api/lib/db.ts';

const SESSION_MODEL = 'App\\Models\\ScheduleSession';
const ACTIVITY_MODEL = 'App\\Models\\ActivitySchedule';
const TYPES = ['orientation', 'training'];

export type HandlerPlan = {
  kind: 'session' | 'activity'; id: number; activity_type: string; status: string; starts_at: string | null;
  applicants: string; handler_id: number | null; handler: string | null; action: 'set' | 'report'; reason?: string;
};

export async function fillMissingHandlers(db: Db, apply: boolean): Promise<HandlerPlan[]> {
  const plans: HandlerPlan[] = [];
  const sessions = await db.query(
    `select s.id, s.activity_type, s.status, s.start_at from schedule_sessions s where s.handler_id is null and s.activity_type = any($1::text[]) order by s.id`, [`{${TYPES.join(',')}}`],
  );
  for (const s of sessions) {
    const seats = await db.query(
      `select p.applicant_id, p.attendance_status, a.full_name, a.applicant_code, a.archived_at, a.assigned_sales_user_id, u.full_name as sales_name
       from schedule_session_participants p join applicants a on a.id = p.applicant_id left join users u on u.id = a.assigned_sales_user_id
       where p.session_id = $1 order by p.id`, [s.id],
    );
    // The people in the session now; a closed session keeps everyone it ever seated.
    const active = seats.filter((p: Row) => !['cancelled', 'removed'].includes(p.attendance_status));
    const people = active.length ? active : seats;
    plans.push(decide('session', s, s.start_at, people));
  }
  const activities = await db.query(
    `select s.id, s.activity_type, s.status, s.starts_at, s.applicant_id, a.full_name, a.applicant_code, a.archived_at, a.assigned_sales_user_id, u.full_name as sales_name
     from activity_schedules s join applicants a on a.id = s.applicant_id left join users u on u.id = a.assigned_sales_user_id
     where s.assigned_to_user_id is null and s.activity_type = any($1::text[]) order by s.id`, [`{${TYPES.join(',')}}`],
  );
  for (const r of activities) plans.push(decide('activity', r, r.starts_at, [r]));
  if (!apply) return plans;

  await db.tx(async (tx) => {
    for (const p of plans.filter((x) => x.action === 'set')) {
      const table = p.kind === 'session' ? 'schedule_sessions' : 'activity_schedules';
      const column = p.kind === 'session' ? 'handler_id' : 'assigned_to_user_id';
      // Only a row that still has no handler is changed.
      const changed = await tx.query(`update ${table} set ${column} = $1 where id = $2 and ${column} is null returning id`, [p.handler_id, p.id]);
      if (!changed.length) { p.action = 'report'; p.reason = 'a handler was set meanwhile: left as it is'; continue; }
      await tx.query(
        `insert into audit_logs (user_id, action, auditable_type, auditable_id, old_values, new_values, created_at) values (null, $1, $2, $3, $4, $5, now())`,
        ['schedule.handler_backfilled', p.kind === 'session' ? SESSION_MODEL : ACTIVITY_MODEL, p.id, JSON.stringify({ [column]: null }),
          JSON.stringify({ [column]: p.handler_id, handler: p.handler, source: "the applicant's assigned Sales user", script: 'fill_missing_handlers' })],
      );
    }
  });
  return plans;
}

function decide(kind: 'session' | 'activity', row: Row, startsAt: unknown, people: Row[]): HandlerPlan {
  const base = {
    kind, id: Number(row.id), activity_type: row.activity_type, status: row.status, starts_at: startsAt ? new Date(startsAt as string).toISOString() : null,
    applicants: people.map((p) => `${p.applicant_code ?? `#${p.applicant_id}`} ${p.full_name}${p.archived_at ? ' (archived)' : ''}`).join(', ') || '—',
    handler_id: null, handler: null,
  };
  if (!people.length) return { ...base, action: 'report', reason: 'no applicants in this session' };
  const unassigned = people.filter((p) => !p.assigned_sales_user_id);
  if (unassigned.length) return { ...base, action: 'report', reason: `no assigned Sales user: ${unassigned.map((p) => p.full_name).join(', ')}` };
  const owners = [...new Set(people.map((p) => Number(p.assigned_sales_user_id)))];
  if (owners.length > 1) return { ...base, action: 'report', reason: 'the applicants have different assigned Sales users' };
  return { ...base, handler_id: owners[0], handler: people[0].sales_name ?? null, action: 'set' };
}

// ---- CLI ----
const isMain = Boolean(process.argv[1]?.split('\\').join('/').endsWith('supabase/scripts/fill_missing_handlers.ts'));
if (isMain) {
  const apply = process.argv.includes('--apply');
  if (apply === process.argv.includes('--dry-run')) { console.error('Usage: exactly one of --dry-run or --apply'); process.exit(2); }
  const { openScriptDb, readOnly } = await import('./lib/scriptDb.ts');
  const db = await openScriptDb();
  const local = (d: string | null) => (d ? new Date(new Date(d).getTime() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '—');
  try {
    // The dry-run reads inside a READ ONLY transaction.
    const plans = apply ? await fillMissingHandlers(db, true) : await readOnly(db, (tx) => fillMissingHandlers(tx, false));
    console.log(apply ? '== APPLIED' : '== DRY RUN (nothing changed)');
    console.table(plans.map((p) => ({
      kind: p.kind, id: p.id, type: p.activity_type, status: p.status, starts: local(p.starts_at), applicants: p.applicants,
      action: p.action === 'set' ? `set handler -> ${p.handler} (#${p.handler_id})` : `report only: ${p.reason}`,
    })));
    console.log(`${plans.filter((p) => p.action === 'set').length} to set, ${plans.filter((p) => p.action === 'report').length} report only`);
  } finally {
    await db.close();
  }
}

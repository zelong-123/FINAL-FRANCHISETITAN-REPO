// Orientation/Tasting sessions store the capacity rule (5). Sessions with a different stored capacity
// are set to 5; a session that already seats more than 5 applicants is only reported. Every change
// is logged in audit_logs.
//
//   node --no-warnings supabase/scripts/normalize_session_capacity.ts --dry-run
//   node --no-warnings supabase/scripts/normalize_session_capacity.ts --apply
import type { Db, Row } from '../functions/api/lib/db.ts';

const SESSION_MODEL = 'App\\Models\\ScheduleSession';
export const ORIENTATION_CAPACITY = 5;

export type CapacityPlan = { id: number; status: string; start_at: string; handler: string | null; capacity: number; participants: number; action: 'set' | 'report'; reason?: string };

export async function normalizeSessionCapacity(db: Db, apply: boolean): Promise<CapacityPlan[]> {
  const rows = await db.query(
    `select s.id, s.status, s.start_at, s.max_capacity, (select full_name from users where id = s.handler_id) as handler,
       (select count(*)::int from schedule_session_participants p where p.session_id = s.id and p.attendance_status not in ('cancelled', 'removed')) as participants
     from schedule_sessions s where s.activity_type = 'orientation' and s.max_capacity is distinct from $1 order by s.id`, [ORIENTATION_CAPACITY],
  );
  const plans: CapacityPlan[] = rows.map((r: Row) => ({
    id: Number(r.id), status: r.status, start_at: new Date(r.start_at).toISOString(), handler: r.handler ?? null, capacity: Number(r.max_capacity), participants: Number(r.participants),
    ...(Number(r.participants) > ORIENTATION_CAPACITY
      ? { action: 'report' as const, reason: `already seats ${r.participants} applicants (more than ${ORIENTATION_CAPACITY}): left as it is` }
      : { action: 'set' as const }),
  }));
  if (!apply) return plans;
  await db.tx(async (tx) => {
    for (const p of plans.filter((x) => x.action === 'set')) {
      const changed = await tx.query(`update schedule_sessions set max_capacity = $1 where id = $2 and max_capacity = $3 returning id`, [ORIENTATION_CAPACITY, p.id, p.capacity]);
      if (!changed.length) { p.action = 'report'; p.reason = 'changed meanwhile: left as it is'; continue; }
      await tx.query(
        `insert into audit_logs (user_id, action, auditable_type, auditable_id, old_values, new_values, created_at) values (null, 'schedule.capacity_normalized', $1, $2, $3, $4, now())`,
        [SESSION_MODEL, p.id, JSON.stringify({ max_capacity: p.capacity }), JSON.stringify({ max_capacity: ORIENTATION_CAPACITY, participants: p.participants, script: 'normalize_session_capacity' })],
      );
    }
  });
  return plans;
}

// ---- CLI ----
const isMain = Boolean(process.argv[1]?.split('\\').join('/').endsWith('supabase/scripts/normalize_session_capacity.ts'));
if (isMain) {
  const apply = process.argv.includes('--apply');
  if (apply === process.argv.includes('--dry-run')) { console.error('Usage: exactly one of --dry-run or --apply'); process.exit(2); }
  const { openScriptDb, readOnly } = await import('./lib/scriptDb.ts');
  const db = await openScriptDb();
  const local = (d: string) => new Date(new Date(d).getTime() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
  try {
    const plans = apply ? await normalizeSessionCapacity(db, true) : await readOnly(db, (tx) => normalizeSessionCapacity(tx, false));
    console.log(apply ? '== APPLIED' : '== DRY RUN (nothing changed)');
    console.table(plans.map((p) => ({
      session: p.id, status: p.status, start: local(p.start_at), handler: p.handler ?? '—', stored_capacity: p.capacity, participants: p.participants,
      shown: `${p.participants}/${ORIENTATION_CAPACITY}${p.participants >= ORIENTATION_CAPACITY ? ' · Full' : ''}`,
      action: p.action === 'set' ? `set ${p.capacity} -> ${ORIENTATION_CAPACITY}` : `report only: ${p.reason}`,
    })));
    console.log(`${plans.filter((p) => p.action === 'set').length} to set, ${plans.filter((p) => p.action === 'report').length} report only`);
  } finally {
    await db.close();
  }
}

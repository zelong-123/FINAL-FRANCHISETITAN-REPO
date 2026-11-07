// ActivitySchedule::renameParticipantName: a rename shows up in scheduled activities too.
import type { Db } from '../lib/db.ts';

export async function renameParticipantName(db: Db, applicantId: number, oldName: string, newName: string): Promise<number> {
  const old = String(oldName ?? '').trim().toLowerCase();
  const next = String(newName ?? '').trim();
  if (!old || !next || old === next.toLowerCase()) return 0;
  let changed = 0;
  for (const schedule of await db.query(`select id, participants from activity_schedules where applicant_id = $1`, [applicantId])) {
    const before: unknown[] = schedule.participants ?? [];
    const after = before.map((name) => (String(name ?? '').trim().toLowerCase() === old ? next : name));
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      await db.query(`update activity_schedules set participants = $1 where id = $2`, [JSON.stringify(after), schedule.id]);
      changed += 1;
    }
  }
  return changed;
}

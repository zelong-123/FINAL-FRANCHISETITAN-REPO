// "Open before you verify": an Admin can accept or verify a submission only after opening every one of
// its current files. Each open (download or in-app preview, which use the same route) is recorded per
// file and per Admin in activity_document_views (the table started with Orientation/Tasting; it keys on
// documents.id, so it serves every document type).
import type { Db, Row } from '../lib/db.ts';
import { fail } from '../lib/http.ts';

/** Records that a user opened a file (first and latest time). */
export async function recordView(db: Db, documentId: number, userId: number) {
  await db.query(
    `insert into activity_document_views (document_id, user_id) values ($1, $2)
     on conflict (document_id, user_id) do update set last_viewed_at = now()`, [documentId, userId],
  );
}

/** Records the view when the downloader is an Admin and the file was served. */
export async function recordAdminView(db: Db, user: Row, document: Row | null | undefined, response: Response) {
  if (document && user.role?.name === 'admin' && response.ok) await recordView(db, Number(document.id), Number(user.id));
}

export interface ViewScope {
  /** documents.documentable_type */
  model: string;
  /** documents.documentable_id */
  ownerId: number;
  /** Only these document types (all when omitted). */
  types?: string[];
  /** Views before this moment do not count (the latest submission); null = any view. */
  since?: Date | string | null;
}

/** The current (not replaced, not removed) files of the scope this user has not opened. */
export async function unviewedFiles(db: Db, scope: ViewScope, userId: number): Promise<Row[]> {
  return db.query(
    `select d.id, d.original_name, d.type from documents d
     where d.documentable_type = $1 and d.documentable_id = $2 and d.replaced_at is null and d.removed_at is null
       and ($3::text[] is null or d.type = any($3::text[]))
       and not exists (select 1 from activity_document_views v where v.document_id = d.id and v.user_id = $4
         and v.last_viewed_at >= coalesce($5::timestamptz, 'epoch'::timestamptz))
     order by d.id`,
    [scope.model, scope.ownerId, scope.types ? `{${scope.types.join(',')}}` : null, userId, scope.since ?? null],
  );
}

/** Refuses the action while any current file of the scope is unopened by this user. */
export async function assertFilesOpened(db: Db, scope: ViewScope, userId: number, field: string, action: string) {
  const unviewed = await unviewedFiles(db, scope, userId);
  if (unviewed.length) {
    fail(field, `Open every submitted file before you ${action}. Not opened yet: ${unviewed.map((d) => d.original_name).join(', ')}.`);
  }
}

/** The ids of the given documents this user has opened (since `since`, when given). */
export async function viewedIds(db: Db, documentIds: number[], userId: number, since: Date | string | null = null): Promise<Set<number>> {
  if (!documentIds.length) return new Set();
  const rows = await db.query(
    `select document_id from activity_document_views where user_id = $1 and document_id = any($2::bigint[])
       and last_viewed_at >= coalesce($3::timestamptz, 'epoch'::timestamptz)`,
    [userId, `{${documentIds.join(',')}}`, since],
  );
  return new Set(rows.map((r) => Number(r.document_id)));
}

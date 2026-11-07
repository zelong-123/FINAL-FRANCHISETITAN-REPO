// Uploads and authenticated downloads, standing in for Laravel's Storage facade.
import type { Context } from 'hono';
import type { AppEnv } from './env.ts';
import type { Db, Row } from './db.ts';
import { abort, insertRow } from './http.ts';

export const MAX_UPLOAD_KB = 10240;

export async function storeDocument(
  c: Context<AppEnv>, db: Db, file: File, dir: string, owner: { type: string; id: number }, documentType: string, metadata?: Row,
): Promise<Row> {
  const extension = file.name.split('.').pop() ?? 'bin';
  const storedName = `${crypto.randomUUID()}.${extension}`;
  const path = `${dir}/${storedName}`;
  await c.get('deps').files.put('private', path, new Uint8Array(await file.arrayBuffer()), file.type || 'application/octet-stream');
  return insertRow(db, 'documents', {
    documentable_type: owner.type, documentable_id: owner.id, type: documentType, original_name: file.name, stored_name: storedName,
    disk: 'private', path, mime_type: file.type || null, size_bytes: file.size, uploaded_by_user_id: c.get('user').id,
    ...(metadata ? { metadata } : {}),
  });
}

export async function downloadDocument(c: Context<AppEnv>, document: Row): Promise<Response> {
  const bytes = await c.get('deps').files.get(document.disk, document.path);
  if (!bytes) abort(404, 'File not found.');
  const name = String(document.original_name).replace(/["\r\n]/g, '');
  return new Response(bytes, {
    headers: {
      'content-type': document.mime_type || 'application/octet-stream',
      'content-disposition': `attachment; filename="${name}"`,
    },
  });
}

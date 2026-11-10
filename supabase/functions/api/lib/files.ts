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

/**
 * The real type of an uploaded file, read from its first bytes (not the name or the browser's
 * claim): PDF starts with "%PDF-", PNG with 89 50 4E 47 0D 0A 1A 0A, JPEG with FF D8 FF.
 */
export async function sniffFileType(file: File): Promise<'application/pdf' | 'image/png' | 'image/jpeg' | null> {
  const b = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return 'application/pdf';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  return null;
}

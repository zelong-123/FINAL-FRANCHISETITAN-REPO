// Production FileStore over Supabase Storage. Bucket names match Laravel's disk names.
import { createClient } from '@supabase/supabase-js';
import type { FileStore } from '../lib/env.ts';

export function supabaseFiles(url: string, serviceKey: string): FileStore {
  const { storage } = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return {
    async put(disk, path, bytes, contentType) {
      const { error } = await storage.from(disk).upload(path, bytes, { contentType, upsert: true });
      if (error) throw new Error(`Could not store the file: ${error.message}`);
    },
    async get(disk, path) {
      const { data, error } = await storage.from(disk).download(path);
      if (error || !data) return null;
      return new Uint8Array(await data.arrayBuffer());
    },
    async remove(disk, paths) {
      if (paths.length) await storage.from(disk).remove(paths);
    },
    publicUrl: (path) => storage.from('public').getPublicUrl(path).data.publicUrl,
  };
}

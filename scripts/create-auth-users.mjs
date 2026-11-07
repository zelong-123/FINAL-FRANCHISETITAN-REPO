// Creates a Supabase Auth sign-in for every seeded user that has none, and links them.
// Development only: every account gets the same password, from SEED_DEFAULT_PASSWORD.
// Usage: npm run users:create
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

const { VITE_SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key, SEED_DEFAULT_PASSWORD: password } = process.env;
if (!url || !key || !password) {
  console.error('Set VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SEED_DEFAULT_PASSWORD in .env first.');
  process.exit(1);
}

const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: users, error } = await admin.from('users').select('id, email').is('auth_user_id', null);
if (error) throw error;

let linked = 0;
for (const user of users) {
  const created = await admin.auth.admin.createUser({ email: user.email, password, email_confirm: true });
  if (created.error) {
    console.error(`${user.email}: ${created.error.message}`);
    continue;
  }
  const update = await admin.from('users').update({ auth_user_id: created.data.user.id }).eq('id', user.id);
  if (update.error) throw update.error;
  linked += 1;
}
console.log(`Linked ${linked} of ${users.length} account(s).`);

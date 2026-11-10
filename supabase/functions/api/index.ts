import postgres from 'postgres';
import { createApp } from './app.ts';
import { postgresDb } from './lib/db.ts';
import { supabaseAuth } from './services/supabaseAuth.ts';
import { supabaseFiles } from './services/supabaseFiles.ts';

const env = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
};

// The new publishable/secret keys, set with `supabase secrets set`, win over the legacy JWT keys
// Supabase injects, so the legacy keys can be disabled.
const publicKey = Deno.env.get('APP_PUBLISHABLE_KEY') || env('SUPABASE_ANON_KEY');
const secretKey = Deno.env.get('APP_SECRET_KEY') || env('SUPABASE_SERVICE_ROLE_KEY');

const db = postgresDb(postgres, env('SUPABASE_DB_URL'));
const auth = supabaseAuth(env('SUPABASE_URL'), publicKey, secretKey, db);
const origins = (Deno.env.get('ALLOWED_ORIGINS') ?? '*').split(',').map((o) => o.trim()).filter(Boolean);

const files = supabaseFiles(env('SUPABASE_URL'), secretKey);

const app = createApp({ db, auth, files, costingEnabled: Deno.env.get('FEATURE_COSTING') === 'true', paymentAdvanced: Deno.env.get('FEATURE_PAYMENT_ADVANCED') === 'true' }, origins);

Deno.serve(app.fetch);

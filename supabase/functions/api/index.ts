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

// Same lookup as the live function (v24). Leave the DATABASE_URL secret UNSET: setting it to the
// pooler string caused an outage; the injected SUPABASE_DB_URL is what works.
const db = postgresDb(postgres, Deno.env.get('DATABASE_URL') || env('SUPABASE_DB_URL'));
const auth = supabaseAuth(env('SUPABASE_URL'), publicKey, secretKey, db);
const origins = (Deno.env.get('ALLOWED_ORIGINS') ?? '*').split(',').map((o) => o.trim()).filter(Boolean);

const files = supabaseFiles(env('SUPABASE_URL'), secretKey);

// Invitation and password-reset links open <APP_STAFF_URL or APP_BRANCH_URL>/reset-password.
const appUrls = { staff: Deno.env.get('APP_STAFF_URL') || null, branch: Deno.env.get('APP_BRANCH_URL') || null };
const inviteTtlHours = Number(Deno.env.get('INVITE_TTL_HOURS') || 24);

const app = createApp({ db, auth, files, costingEnabled: Deno.env.get('FEATURE_COSTING') === 'true', appUrls, inviteTtlHours }, origins);

Deno.serve(app.fetch);
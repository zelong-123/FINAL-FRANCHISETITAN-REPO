import { createClient } from '@supabase/supabase-js';

const PERSIST_KEY = 'herald_persist_token';

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
if (!url || !anonKey) {
  throw new Error('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env (see .env.example).');
}

export const SUPABASE_URL = url.replace(/\/$/, '');

// "Keep me signed in" decides where the session lives: this tab only, or this browser.
const sessionStore = {
  getItem: (key) => sessionStorage.getItem(key) ?? localStorage.getItem(key),
  setItem: (key, value) => {
    const persist = localStorage.getItem(PERSIST_KEY) === '1';
    (persist ? localStorage : sessionStorage).setItem(key, value);
    (persist ? sessionStorage : localStorage).removeItem(key);
  },
  removeItem: (key) => {
    sessionStorage.removeItem(key);
    localStorage.removeItem(key);
  },
};

export const supabase = createClient(SUPABASE_URL, anonKey, {
  auth: { storage: sessionStore, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

export function setPersistSession(persist) {
  localStorage.setItem(PERSIST_KEY, persist ? '1' : '0');
}

export function clearPersistSession() {
  localStorage.removeItem(PERSIST_KEY);
}

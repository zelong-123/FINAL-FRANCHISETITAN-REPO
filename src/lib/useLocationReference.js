import { useEffect, useSyncExternalStore } from 'react';
import { api } from './api';

// ---- The built-in PSGC list, loaded once per page load (GET /ph-locations) ----
let reference = null;
let request = null;
const listeners = new Set();
export function loadLocationReference() {
  if (!request) {
    request = api.get('/ph-locations')
      .then((response) => { reference = response.data; listeners.forEach((l) => l()); })
      .catch(() => { request = null; });
  }
  return request;
}
/** The provinces and cities/municipalities, re-rendering the caller when they arrive (null until then). */
export default function useLocationReference() {
  useEffect(() => { void loadLocationReference(); }, []);
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => reference);
}

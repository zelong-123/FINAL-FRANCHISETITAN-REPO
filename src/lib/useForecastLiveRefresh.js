import { useEffect, useRef } from 'react';
import { api } from './api';

/**
 * Estimated requirement live refresh.
 *
 * Polls /sync-status (the same endpoint live-sync.js uses) and calls onChange
 * when forecast_version moves — new production, a void, a closure, an
 * exclusion, a settings change or a supply request. Unlike live-sync.js it does
 * not reload the page, so the chosen branch and filters are kept.
 */
export default function useForecastLiveRefresh(onChange, intervalMs = 15000) {
  const callback = useRef(onChange);
  useEffect(() => { callback.current = onChange; }, [onChange]);

  useEffect(() => {
    let baseline = null;
    let running = false;
    let alive = true;

    const check = async () => {
      if (running || document.visibilityState !== 'visible') return;
      running = true;
      try {
        const response = await api.get('/sync-status');
        const version = String(response?.data?.forecast_version ?? '');
        if (alive && baseline !== null && version !== baseline) callback.current?.();
        baseline = version;
      } catch {
        // Ignore: the page's own requests surface server errors.
      } finally {
        running = false;
      }
    };

    void check();
    const timer = window.setInterval(check, intervalMs);
    window.addEventListener('focus', check);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', check);
    };
  }, [intervalMs]);
}

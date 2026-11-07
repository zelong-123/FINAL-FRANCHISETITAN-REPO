import { useEffect, useSyncExternalStore } from 'react';
import { api } from './api';
import { getScheduleConfig, setScheduleConfig, subscribeScheduleConfig } from './scheduleConfig';

let request = null;

/** Load the scheduling window once per page load (retried after a failure). */
export function loadScheduleConfig() {
  if (!request) {
    request = api.get('/schedule-sessions/config')
      .then((response) => setScheduleConfig(response.data))
      .catch(() => { request = null; }); // keep the defaults; try again next time
  }
  return request;
}

/** The scheduling window, re-rendering the caller when it arrives. */
export default function useScheduleConfig() {
  useEffect(() => { void loadScheduleConfig(); }, []);
  return useSyncExternalStore(subscribeScheduleConfig, getScheduleConfig);
}

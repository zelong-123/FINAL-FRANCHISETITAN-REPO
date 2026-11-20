import { api } from './api';
import useRemote from './useRemote';

/**
 * The calendar picker data for one applicant + activity + month (GET /schedule-sessions/availability):
 * the applicant's Sales user only, the selected activity only. Re-fetched when any input changes.
 * { data, loading, error }; data is null until an applicant and an activity are chosen.
 */
export default function useAvailability(applicantId, activityType, month, durationMinutes) {
  return useRemote(async () => {
    if (!applicantId || !activityType || !month) return null;
    return (await api.get('/schedule-sessions/availability', {
      applicant_id: applicantId, activity_type: activityType, month, duration_minutes: durationMinutes || undefined,
    })).data;
  }, [applicantId, activityType, month, durationMinutes]);
}

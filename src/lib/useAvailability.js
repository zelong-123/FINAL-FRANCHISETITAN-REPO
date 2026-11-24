import { api } from './api';
import useRemote from './useRemote';

/**
 * The calendar picker data for one applicant + activity + month (GET /schedule-sessions/availability):
 * the applicant's Sales user only, the selected activity only. Re-fetched when any input changes.
 * { data, loading, error }; data is null until an applicant and an activity are chosen.
 *
 * `ignore` is the activity being adjusted (Edit): { activityId, sessionId }. Its current session is
 * left out of the busy hours (and of the dots), so its own day/time is not shown as occupied.
 */
export default function useAvailability(applicantId, activityType, month, durationMinutes, ignore = null) {
  const ignoreActivityId = ignore?.activityId ?? null;
  const ignoreSessionId = ignore?.sessionId ?? null;
  return useRemote(async () => {
    if (!applicantId || !activityType || !month) return null;
    return (await api.get('/schedule-sessions/availability', {
      applicant_id: applicantId, activity_type: activityType, month, duration_minutes: durationMinutes || undefined,
      ignore_activity_id: ignoreActivityId || undefined,
      ignore_session_id: ignoreSessionId || undefined,
    })).data;
  }, [applicantId, activityType, month, durationMinutes, ignoreActivityId, ignoreSessionId]);
}

/**
 * The same calendar for the Master Schedule's session modal, which has no single applicant:
 * the handler picked in the form (`handler_id`, may be null) and the selected activity only.
 * `ignoreSessionId` is the session being edited, so its own day/time is not shown as occupied.
 */
export function useSessionAvailability(handlerId, activityType, month, durationMinutes, ignoreSessionId = null) {
  return useRemote(async () => {
    if (!activityType || !month) return null;
    return (await api.get('/schedule-sessions/availability', {
      handler_id: handlerId || undefined, activity_type: activityType, month, duration_minutes: durationMinutes || undefined,
      ignore_session_id: ignoreSessionId || undefined,
    })).data;
  }, [handlerId, activityType, month, durationMinutes, ignoreSessionId]);
}

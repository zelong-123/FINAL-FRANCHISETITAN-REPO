// How an account's status reads in User management (and the Archive). Pure, so it is tested.

const STYLES = {
  invited: { color: '#fb923c', background: 'rgba(251, 146, 60, 0.12)', borderColor: 'rgba(251, 146, 60, 0.4)' },
  expired: { color: '#fbbf24', background: 'rgba(251, 191, 36, 0.12)', borderColor: 'rgba(251, 191, 36, 0.4)' },
  declined: { color: '#f87171', background: 'rgba(248, 113, 113, 0.12)', borderColor: 'rgba(248, 113, 113, 0.4)' },
};

const when = (value) => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * { key, label, detail, style }: an invitation nobody accepted shows Invited / Expired / Declined;
 * a suspension shows its window; otherwise online (Active) or offline (InActive).
 */
export function accountBadge(user, presence = {}) {
  const state = user.invite_state;
  if (state === 'invited') return { key: 'invited', label: 'Invited', detail: user.invited_at ? `Invite sent ${when(user.invited_at)}` : null, style: STYLES.invited };
  if (state === 'expired') return { key: 'expired', label: 'Expired', detail: 'The invite link expired: resend it', style: STYLES.expired };
  if (state === 'declined') return { key: 'declined', label: 'Declined', detail: 'They declined the invitation', style: STYLES.declined };
  if (user.account_status === 'suspended') {
    return { key: 'suspended', label: 'Suspended', detail: `${user.suspended_from ? when(user.suspended_from) : 'Now'} – ${user.suspended_until ? when(user.suspended_until) : 'until restored'}`, style: undefined };
  }
  if (user.account_status === 'inactive') return { key: 'inactive', label: 'Deactivated', detail: null, style: undefined };
  if (presence.is_online) return { key: 'active', label: 'Active', detail: null, style: undefined };
  return { key: 'inactive', label: 'InActive', detail: presence.last_active ? `Last active ${when(presence.last_active)}` : null, style: undefined };
}

/** "YYYY-MM-DDTHH:MM" in the browser's own time, for <input type="datetime-local">. */
export function localDateTimeInput(date = new Date()) {
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 16);
}

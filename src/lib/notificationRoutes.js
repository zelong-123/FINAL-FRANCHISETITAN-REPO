// Where a notification leads, by type prefix. Unknown types return null and only mark as read.
//
// Click behavior (Header bell): the item is marked as read first, then the app
// navigates and the receiving page opens the exact record it is about.
export function notificationTarget(item) {
  const type = String(item?.type || '');
  // A backend payload with an explicit url always wins (notification.data.url).
  if (item?.data?.url) {
    return { path: String(item.data.url), state: item.data.state ?? null };
  }
  if (type.startsWith('inquiry')) return { path: '/inquiries', state: { focusInquiryId: item.data?.inquiry_id ?? null } };
  if (type === 'branch_low_stock') return { path: '/inventory' };
  if (type.startsWith('supply_request')) return { path: '/supply-requests', state: { focusSupplyRequestId: item.data?.supply_request_id ?? null } };
  if (type.startsWith('schedule') || type.startsWith('activity')) return { path: '/activities', state: { focusActivityId: item.data?.activity_id ?? null } };
  // Franchisee records live in the Application Detail area: open the Franchisees
  // tab, then the applicant's modal when the payload carries an id.
  if (type.startsWith('franchisee')) {
    return { path: '/applicants', state: { focusTab: 'franchisees', focusApplicantId: item.data?.applicant_id ?? null } };
  }
  if (type.startsWith('applicant') || type.startsWith('payment') || type === 'loi_uploaded') {
    return { path: '/applicants', state: { focusApplicantId: item.data?.applicant_id ?? null } };
  }
  return null;
}

export function notificationPath(item) {
  return notificationTarget(item)?.path || null;
}

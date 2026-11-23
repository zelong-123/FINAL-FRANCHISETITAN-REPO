/**
 * One extra breadcrumb a page can add to the header — e.g. the branch that is open
 * in the Branches full view. The header subscribes to this store; the page sets it
 * while its sub-view is open and clears it when it returns to its default view.
 *
 * `back` is optional: when present, the crumb before it in the trail (the page
 * itself) becomes the link that runs it, so the page can reset its own state
 * instead of just re-navigating to the same route.
 */
let current = null;
const listeners = new Set();

export function getHeaderCrumb() {
  return current;
}

export function subscribeHeaderCrumb(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setHeaderCrumb(next) {
  const value = next && next.label
    ? { label: String(next.label), back: typeof next.back === 'function' ? next.back : null }
    : null;
  if (value?.label === current?.label && value?.back === current?.back) return;
  current = value;
  listeners.forEach((listener) => listener());
}

    // Single source of truth for brand text colors.
// Add a new brand here (key = brand name in lowercase, letters/numbers only).
const BRAND_COLORS = {
  godo: '#31c567',       // GoDo       - green
  lapasta: '#dd5959',    // La Pasta   - red
  kkopi: '#fb923c',      // Kkopi      - orange
  dailydash: '#60a5fa',  // Daily Dash - blue
};

// Used for any brand that is not listed above (new or renamed brands).
export const FALLBACK_BRAND_COLOR = '#c7cde0';

const keyOf = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Returns a color for a brand name, or undefined when there is no name at all.
export function brandColor(name) {
  const key = keyOf(name);
  if (!key) return undefined;
  return BRAND_COLORS[key] || FALLBACK_BRAND_COLOR;
}
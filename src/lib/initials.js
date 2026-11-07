/**
 * Avatar initials from a person's own name.
 * Rule: first letter of the first word + first letter of the second word,
 * uppercased. A single word gives one letter. "Leigh Hannah Amora" -> "LH".
 * Empty input or the em dash placeholder gives "?".
 */
export function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length || parts[0] === '\u2014') return '?';
  const first = parts[0][0];
  const second = parts.length > 1 ? parts[1][0] : '';
  return (first + second).toUpperCase();
}

export default initialsOf;

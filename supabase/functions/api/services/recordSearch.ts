// App\Support\RecordSearch: exact code > partial code > name/email > phone.
// Expressions are trusted SQL written in code; the term is always bound.
import type { Filter } from '../lib/http.ts';

export function applyRecordSearch(filter: Filter, raw: unknown, codes: string[], texts: string[], phones: string[]) {
  const term = String(raw ?? '').trim().toLowerCase();
  if (!term) return null;
  const like = `%${term}%`;
  const matches = [
    ...[...codes, ...texts].map((e) => `lower(${e}) like ?`),
    ...phones.map((c) => `${c} like ?`),
  ];
  filter.add(`(${matches.join(' or ')})`, ...matches.map(() => like));
  const exact = codes.map((e) => `lower(${e}) = ?`).join(' or ');
  const partial = codes.map((e) => `lower(${e}) like ?`).join(' or ');
  const text = texts.map((c) => `lower(${c}) like ?`).join(' or ') || '1 = 0';
  return {
    orderBy: `case when (${exact}) then 0 when (${partial}) then 1 when (${text}) then 2 else 3 end`,
    orderParams: [...codes.map(() => term), ...codes.map(() => like), ...texts.map(() => like)],
  };
}

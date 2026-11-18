// Regression guard for the Master Schedule render crash: the range effect read
// `mode` and `weekStart` before their `const` declarations, which throws
// "Cannot access 'mode' before initialization" on the first render.
// The project has no DOM renderer, so this checks declaration order in the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../pages/MasterSchedule.jsx', import.meta.url), 'utf8');
const declaredAt = (name) => {
  const match = source.match(new RegExp(`const ${name} = `));
  assert.ok(match, `missing declaration of ${name}`);
  return match.index;
};

test('mode and weekStart are declared before the range effect reads them', () => {
  const rangeEffect = source.indexOf('setRange({ from: `${weekStart}');
  assert.ok(rangeEffect > 0, 'range effect not found');
  assert.ok(declaredAt('mode') < rangeEffect, 'mode must be declared before the range effect');
  assert.ok(declaredAt('weekStart') < rangeEffect, 'weekStart must be declared before the range effect');
});

test('no render-time use of mode or weekStart before their declarations', () => {
  const modeDeclared = declaredAt('mode');
  const weekStartDeclared = declaredAt('weekStart');
  const before = source.slice(0, Math.min(modeDeclared, weekStartDeclared));
  assert.doesNotMatch(before, /\[[^\]]*\b(mode|weekStart)\b[^\]]*\]\);/, 'a hook dependency list reads mode or weekStart before declaration');
});

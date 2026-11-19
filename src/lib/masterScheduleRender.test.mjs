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
  const rangeSet = source.search(/setRange\s*\(\s*\{\s*from\s*:/);
  assert.ok(rangeSet > 0, 'range effect not found');
  const rangeEffectStart = source.lastIndexOf('useEffect(() => {', rangeSet);
  assert.ok(rangeEffectStart >= 0, 'range effect hook not found');
  const dependencyEnd = source.indexOf(']);', rangeSet);
  assert.ok(dependencyEnd > rangeSet, 'range effect dependency list not found');
  const rangeEffect = source.slice(rangeEffectStart, dependencyEnd + 3);
  assert.match(rangeEffect, /\bmode\b/, 'range effect must read mode');
  assert.match(rangeEffect, /\bweekStart\b/, 'range effect must read weekStart');
  assert.ok(declaredAt('mode') < rangeEffectStart, 'mode must be declared before the range effect');
  assert.ok(declaredAt('weekStart') < rangeEffectStart, 'weekStart must be declared before the range effect');
});

test('no render-time use of mode or weekStart before their declarations', () => {
  const modeDeclared = declaredAt('mode');
  const weekStartDeclared = declaredAt('weekStart');
  const before = source.slice(0, Math.min(modeDeclared, weekStartDeclared));
  assert.doesNotMatch(before, /\[[^\]]*\b(mode|weekStart)\b[^\]]*\]\);/, 'a hook dependency list reads mode or weekStart before declaration');
});

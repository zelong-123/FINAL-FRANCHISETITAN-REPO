import React from 'react';
import { locationShown } from '../lib/locations';

/** A structured location; an unmatched older record shows its typed text with a small "legacy" hint. */
export default function LocationValue({ loc, legacy = null, noneMarked = false, empty = null }) {
  const { text, legacy: isLegacy } = locationShown(loc, legacy, noneMarked);
  if (!text) return empty;
  return (
    <>
      {text}
      {isLegacy && <small className="ml-[6px] text-[11px] text-muted" title="Typed before standardized locations; no Province/City matched yet.">legacy</small>}
    </>
  );
}

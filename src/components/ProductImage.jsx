import React, { useState } from 'react';

/**
 * A product picture that falls back to the placeholder when there is no URL or
 * the image fails to load, so a broken icon or alt text never shows.
 */
export default function ProductImage({ src, alt = '', fallback = null }) {
  const [failedSrc, setFailedSrc] = useState(null);
  if (!src || failedSrc === src) return fallback;
  return <img src={src} alt={alt} loading="lazy" onError={() => setFailedSrc(src)} />;
}

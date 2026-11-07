/** Accepted product picture types and size; the backend enforces the same rule. */
export const PRODUCT_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const PRODUCT_IMAGE_ACCEPT = PRODUCT_IMAGE_TYPES.join(',');
export const PRODUCT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** Returns an error message for a picked file, or '' when it is acceptable. */
export function productImageError(file) {
  if (!file) return '';
  const extensionOk = /\.(jpe?g|png|webp)$/i.test(file.name || '');
  if (!PRODUCT_IMAGE_TYPES.includes(file.type) || !extensionOk) {
    return 'The picture must be a JPG, JPEG, PNG or WEBP image.';
  }
  if (file.size > PRODUCT_IMAGE_MAX_BYTES) return 'The picture must not be larger than 5 MB.';
  return '';
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCT_IMAGE_MAX_BYTES, productImageError } from './productImage.js';

const file = (name, type, size = 1000) => ({ name, type, size });

test('accepts jpg, jpeg, png and webp up to 5 MB', () => {
  for (const [name, type] of [['a.jpg', 'image/jpeg'], ['a.JPEG', 'image/jpeg'], ['a.png', 'image/png'], ['a.webp', 'image/webp']]) {
    assert.equal(productImageError(file(name, type)), '');
  }
  assert.equal(productImageError(file('a.jpg', 'image/jpeg', PRODUCT_IMAGE_MAX_BYTES)), '');
});

test('rejects other types with a clear message', () => {
  assert.match(productImageError(file('a.gif', 'image/gif')), /JPG, JPEG, PNG or WEBP/);
  assert.match(productImageError(file('a.pdf', 'application/pdf')), /JPG, JPEG, PNG or WEBP/);
  assert.match(productImageError(file('a.pdf', 'image/png')), /JPG, JPEG, PNG or WEBP/);
});

test('rejects files over 5 MB', () => {
  assert.equal(productImageError(file('a.png', 'image/png', PRODUCT_IMAGE_MAX_BYTES + 1)), 'The picture must not be larger than 5 MB.');
});

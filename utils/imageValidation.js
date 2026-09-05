'use strict';

/**
 * Validate that an uploaded image buffer matches its declared MIME type.
 * MIME types come from the client and therefore cannot be trusted alone.
 */
const IMAGE_SIGNATURES = {
  'image/jpeg': (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/gif': (b) => b.length >= 6 && (b.subarray(0, 6).toString('ascii') === 'GIF87a' || b.subarray(0, 6).toString('ascii') === 'GIF89a'),
  'image/webp': (b) => b.length >= 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
};

const validateImageBuffer = (buffer, mimetype) => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { valid: false, message: 'Uploaded image is empty or invalid.' };
  }

  const checker = IMAGE_SIGNATURES[mimetype];
  if (!checker || !checker(buffer)) {
    return { valid: false, message: 'Uploaded file is not a valid supported image.' };
  }

  return { valid: true };
};

module.exports = { validateImageBuffer };

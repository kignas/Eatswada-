'use strict';

const CLOUDINARY_HOST = 'res.cloudinary.com';

/**
 * Returns the normalised URL if `value` is an https image URL served from OUR Cloudinary cloud
 * (https://res.cloudinary.com/<CLOUDINARY_CLOUD_NAME>/...), otherwise null.
 *
 * Checked on the parsed URL, not with a prefix regex, so userinfo (res.cloudinary.com@evil.com), ports,
 * look-alike or sub-domain hosts, "../" / "%2e%2e" path tricks and cloud-name prefix look-alikes
 * ("<cloud>-evil") all fail. If CLOUDINARY_CLOUD_NAME is not configured nothing passes (fail closed).
 * Callers should store the returned (normalised) value, not the raw input.
 */
function normalizeOwnCloudinaryUrl(value, maxLength = 1000) {
  const cloudName = String(process.env.CLOUDINARY_CLOUD_NAME || '').trim();
  if (!cloudName) return null;
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > maxLength) return null;

  let url;
  try { url = new URL(raw); } catch (_) { return null; }
  if (url.protocol !== 'https:' || url.hostname !== CLOUDINARY_HOST) return null;
  if (url.username || url.password || url.port) return null;
  if (!url.pathname.startsWith(`/${cloudName}/`)) return null;
  return url.href;
}

module.exports = { CLOUDINARY_HOST, normalizeOwnCloudinaryUrl };

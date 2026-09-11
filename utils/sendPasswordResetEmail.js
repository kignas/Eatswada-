/**
 * Eatswada password-reset email service — Brevo HTTPS API
 *
 * Required:
 *   BREVO_API_KEY
 *   EMAIL_FROM
 *
 * This service sends a 6-digit password-reset OTP. No reset link is sent.
 * CUSTOMER_WEB_URL is intentionally not used.
 */

const https = require('https');

function parseSender(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^\s*(.*?)\s*<([^<>@\s]+@[^<>@\s]+)>\s*$/);

  if (match) return { name: match[1].trim() || 'Eatswada', email: match[2].trim() };

  if (/^[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+$/.test(raw)) {
    return { name: 'Eatswada', email: raw };
  }

  return null;
}

function postToBrevo(payload, apiKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);

    const req = https.request({
      hostname: 'api.brevo.com',
      path: '/v3/smtp/email',
      method: 'POST',
      headers: {
        accept: 'application/json',
        'api-key': apiKey,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      timeout: 15000,
    }, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { responseBody += chunk; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = responseBody ? JSON.parse(responseBody) : {}; } catch { parsed = {}; }

        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
          return;
        }

        const err = new Error(
          parsed?.message || parsed?.code ||
          `Brevo API request failed with HTTP ${res.statusCode}`
        );
        err.statusCode = res.statusCode;
        err.brevoCode = parsed?.code;
        reject(err);
      });
    });

    req.on('timeout', () => req.destroy(new Error('Brevo API request timed out')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendPasswordResetOTP({ to, otp }) {
  const apiKey = String(process.env.BREVO_API_KEY || '').trim();
  const sender = parseSender(process.env.EMAIL_FROM);

  if (!apiKey) {
    const err = new Error('Password reset email service is not configured');
    err.statusCode = 503;
    console.error('[BREVO-DIAGNOSTIC] Missing BREVO_API_KEY.');
    throw err;
  }

  if (!sender) {
    const err = new Error('Password reset email sender is not configured');
    err.statusCode = 503;
    console.error('[BREVO-DIAGNOSTIC] EMAIL_FROM is missing or invalid.');
    throw err;
  }

  if (!to || !otp) {
    const err = new Error('Password reset email recipient or OTP is missing');
    err.statusCode = 400;
    throw err;
  }

  const payload = {
    sender,
    to: [{ email: String(to).trim() }],
    subject: 'Your Eatswada password reset OTP',
    textContent:
      `Your Eatswada password reset OTP is: ${otp}\n\n` +
      `This OTP expires in 10 minutes. You have limited attempts to enter it.\n\n` +
      `If you did not request a password reset, you can safely ignore this email.`,
    htmlContent:
      '<!doctype html><html><body style="font-family:Arial,sans-serif;line-height:1.6">' +
      '<div style="max-width:520px;margin:auto;padding:24px">' +
      '<h2 style="margin-bottom:8px">Eatswada password reset</h2>' +
      '<p>We received a request to reset your Eatswada password.</p>' +
      '<p style="margin:24px 0;font-size:32px;letter-spacing:8px;font-weight:800">' +
      `${otp}</p>` +
      '<p>This OTP expires in <strong>10 minutes</strong>.</p>' +
      '<p>Never share this OTP with anyone.</p>' +
      '<p>If you did not request this, you can safely ignore this email.</p>' +
      '</div></body></html>',
  };

  console.log('[BREVO-DIAGNOSTIC] Sending password-reset OTP via Brevo.');

  try {
    const result = await postToBrevo(payload, apiKey);
    console.log(
      `[BREVO-DIAGNOSTIC] Password-reset OTP accepted by Brevo. ` +
      `messageId=${result?.messageId ? 'received' : 'not-returned'}`
    );
    return result;
  } catch (err) {
    console.error(`[BREVO-DIAGNOSTIC] Brevo OTP send failed: ${err?.message || err}`);
    throw err;
  }
}

module.exports = { sendPasswordResetOTP };

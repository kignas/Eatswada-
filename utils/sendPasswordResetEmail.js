const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const host = String(process.env.SMTP_HOST || '').trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '');

  console.log(`[SMTP-DIAGNOSTIC] Config host=${host || 'missing'} port=${port} user=${user ? 'configured' : 'missing'} password=${pass ? 'configured' : 'missing'}`);

  if (!host || !user || !pass) {
    const err = new Error('Password reset email service is not configured');
    err.statusCode = 503;
    console.error('[SMTP-DIAGNOSTIC] Missing required SMTP configuration.');
    throw err;
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });

  return transporter;
}

async function sendPasswordResetEmail({ to, resetToken }) {
  const from = String(process.env.EMAIL_FROM || process.env.SMTP_USER || '').trim();
  const webBase = String(process.env.CUSTOMER_WEB_URL || '').trim().replace(/\/$/, '');

  if (!from || !webBase) {
    const err = new Error('Password reset email service is not fully configured');
    err.statusCode = 503;
    throw err;
  }

  const resetUrl = `${webBase}/reset-password.html?token=${encodeURIComponent(resetToken)}`;
  const transporter = getTransporter();

  console.log(`[SMTP-DIAGNOSTIC] Sending password-reset email host=${String(process.env.SMTP_HOST || '').trim() || 'missing'} port=${Number(process.env.SMTP_PORT || 587)} from=${from ? 'configured' : 'missing'}`);
  try {
    await transporter.verify();
    console.log('[SMTP-DIAGNOSTIC] SMTP connection/authentication verified.');
  } catch (err) {
    console.error(`[SMTP-DIAGNOSTIC] SMTP verify failed: ${err?.message || err}`);
    throw err;
  }

  try {
    await transporter.sendMail({
    from,
    to,
    subject: 'Reset your Eatswada password',
    text: `Reset your Eatswada password using this link:\n\n${resetUrl}\n\nThis link expires in 10 minutes. If you did not request this, you can ignore this email.`,
    html: `<!doctype html><html><body style="font-family:Arial,sans-serif;line-height:1.6"><h2>Eatswada password reset</h2><p>We received a request to reset your Eatswada password.</p><p><a href="${resetUrl}" style="display:inline-block;padding:12px 18px;background:#15803d;color:#fff;text-decoration:none;border-radius:8px">Reset password</a></p><p>This link expires in <strong>10 minutes</strong>.</p><p>If you did not request this, you can safely ignore this email.</p></body></html>`,
    });
    console.log('[SMTP-DIAGNOSTIC] Password-reset email accepted by SMTP server.');
  } catch (err) {
    console.error(`[SMTP-DIAGNOSTIC] sendMail failed: ${err?.message || err}`);
    throw err;
  }
}

module.exports = { sendPasswordResetEmail };

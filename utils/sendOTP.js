/**
 * sendOTP utility
 * Supports:  mock (dev only) | twilio | msg91
 *
 * In production set OTP_PROVIDER=twilio or msg91 in .env.
 * The server refuses to start an OTP flow in mock mode in production —
 * silently "sending" an OTP nobody receives is worse than a hard failure.
 */

const crypto = require('crypto');

const OTP_LENGTH = 6;

// crypto.randomInt is cryptographically secure. Math.random is not, and an
// OTP generated from it is predictable from previous outputs.
const generateOTPCode = () =>
  String(crypto.randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');

const sendOTP = async (phone, otp) => {
  const provider = process.env.OTP_PROVIDER || 'mock';

  if (provider === 'mock') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'OTP_PROVIDER is not configured. Set OTP_PROVIDER=msg91 or twilio before serving traffic.'
      );
    }
    // Development only: log the OTP so you can test without SMS credits.
    console.log(`📲 [MOCK OTP] Phone: ${phone}  OTP: ${otp}`);
    return { success: true, provider: 'mock' };
  }

  if (provider === 'twilio') {
    const twilio = require('twilio');
    const client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
    await client.messages.create({
      body: `Your Eatswada OTP is: ${otp}. Valid for 5 minutes.`,
      from: process.env.TWILIO_PHONE,
      to: phone,
    });
    return { success: true, provider: 'twilio' };
  }

  if (provider === 'msg91') {
    const axios = require('axios');
    await axios.post('https://api.msg91.com/api/v5/otp', {
      template_id: process.env.MSG91_TEMPLATE_ID,
      mobile: phone.replace('+', ''),
      authkey: process.env.MSG91_AUTH_KEY,
      otp,
    });
    return { success: true, provider: 'msg91' };
  }

  throw new Error(`Unknown OTP provider: ${provider}`);
};

module.exports = { sendOTP, generateOTPCode, OTP_LENGTH };

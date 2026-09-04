/**
 * sendOTP utility
 * Supports:  mock (dev/test) | twilio | msg91
 *
 * In production set OTP_PROVIDER=twilio or msg91 in .env
 */

const generateOTPCode = () =>
  Math.floor(1000 + Math.random() * 9000).toString(); // 4-digit OTP

const sendOTP = async (phone, otp) => {
  const provider = process.env.OTP_PROVIDER || 'mock';

  if (provider === 'mock') {
    // Development: just log the OTP
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
      body: `Your Nearbite OTP is: ${otp}. Valid for 5 minutes.`,
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

module.exports = { sendOTP, generateOTPCode };

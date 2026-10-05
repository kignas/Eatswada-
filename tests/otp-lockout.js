'use strict';

/*
 * OTP brute-force lockout regression gate.
 *
 * Background: User.otp.attempts and User.otp.lockedUntil are `select: false`.
 * checkOTP() (models/User.js) increments attempts and sets lockedUntil, but it
 * can only do that if the query actually LOADED those fields. A projection that
 * omits them silently disables the per-account lockout, letting an attacker keep
 * guessing the OTP (the IP limiter alone is not sufficient — mobile/proxy IPs
 * rotate).
 *
 * This gate proves the fix two ways:
 *   1. Static: every handler that calls checkOTP('login') requests the lockout
 *      fields, so the guard cannot regress when the select string is edited.
 *   2. Behavioural: using the real model methods offline (User.hydrate), a
 *      document that carries attempts/lockedUntil locks out after 5 wrong
 *      guesses, while a document missing them does not — the exact failure the
 *      fix prevents.
 *
 * No MongoDB / SMS / network is required.
 */

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const User = require('../models/User');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const users = read('controllers/userController.js');

// ── Static: every checkOTP('login') caller must load the lockout fields ──
function selectFor(handlerName, source) {
  const m = source.match(new RegExp(`const ${handlerName}[\\s\\S]*?\\.select\\(([^)]*)\\)`));
  return m ? m[1] : '';
}
const registerSelect = selectFor('register', users);
const verifySelect = selectFor('verifyOTPHandler', users);
const sendSelect = selectFor('sendOTPHandler', users);

check('register loads otp.attempts', /\+otp\.attempts/.test(registerSelect), registerSelect);
check('register loads otp.lockedUntil', /\+otp\.lockedUntil/.test(registerSelect), registerSelect);
check('verify-otp loads otp.attempts', /\+otp\.attempts/.test(verifySelect), verifySelect);
check('verify-otp loads otp.lockedUntil', /\+otp\.lockedUntil/.test(verifySelect), verifySelect);
check('send-otp loads otp.attempts', /\+otp\.attempts/.test(sendSelect), sendSelect);
check('send-otp loads otp.lockedUntil', /\+otp\.lockedUntil/.test(sendSelect), sendSelect);

// ── Behavioural: the real model methods ──
//
// The bug is cross-request: every HTTP request does a fresh findOne(), so the
// persisted attempts count is only visible if the projection loaded it. A
// single in-memory document always locks (it increments in place), so we must
// simulate separate requests — a fresh hydrated document each guess, carrying
// forward only what the projection actually returned.
const future = new Date(Date.now() + 5 * 60 * 1000);

function freshUser(otpFields) {
  return User.hydrate({
    _id: new mongoose.Types.ObjectId(),
    phone: '+919999999999',
    otp: otpFields,
  }, null, { defaults: false });
}

// 1. A pre-locked account is rejected immediately, even with the correct OTP.
{
  const u = freshUser({ code: '1234', expiresAt: future, purpose: 'login', attempts: 5, lockedUntil: future });
  const r = u.checkOTP('1234', 'login');
  check('locked account is rejected even with the correct OTP', r.ok === false && r.reason === 'locked', JSON.stringify(r));
}

// 2. Five wrong guesses across five separate requests lock the account.
{
  let stored = { code: '1234', expiresAt: future, purpose: 'login', attempts: 0, lockedUntil: null };
  let locked = false;
  for (let i = 0; i < 5; i++) {
    const u = freshUser({ ...stored });
    const r = u.checkOTP('0000', 'login');
    stored = { ...stored, attempts: u.otp.attempts, lockedUntil: u.otp.lockedUntil || null };
    if (r.reason === 'locked' || r.reason === 'locked_now') { locked = true; break; }
  }
  check('five wrong guesses across requests lock the account (fields loaded)', locked);
}

// 3. The exact failure the fix prevents: when the projection omits the lockout
//    fields, each request reloads attempts as absent and the account never
//    locks no matter how many guesses are made.
{
  let stored = { code: '1234', expiresAt: future, purpose: 'login' };
  let everLocked = false;
  for (let i = 0; i < 12; i++) {
    const u = freshUser({ ...stored });
    // Projection omitted these -> the DB value is invisible to this request.
    u.otp.attempts = undefined;
    u.otp.lockedUntil = undefined;
    const r = u.checkOTP('0000', 'login');
    stored = { ...stored, attempts: u.otp.attempts, lockedUntil: u.otp.lockedUntil || null };
    if (r.reason === 'locked' || r.reason === 'locked_now') { everLocked = true; break; }
  }
  check('omitting attempts/lockedUntil bypasses the lockout (why the fix matters)', everLocked === false);
}

console.log(`\nOTP lockout gate: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

const User          = require('../models/User');
const Address       = require('../models/Address');
const generateToken = require('../utils/generateToken');
const { sendOTP, generateOTPCode } = require('../utils/sendOTP');
const asyncHandler  = require('express-async-handler');

const sendOTPHandler = asyncHandler(async (req, res) => {
  const { phone } = req.body;
  const otp = generateOTPCode();
  await User.findOneAndUpdate(
    { phone },
    { phone, otp: { code: otp, expiresAt: new Date(Date.now() + 5 * 60 * 1000) } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  await sendOTP(phone, otp);
  res.json({ success: true, message: 'OTP sent successfully' });
});

const verifyOTPHandler = asyncHandler(async (req, res) => {
  const { phone, otp } = req.body;
  const user = await User.findOne({ phone }).select('+otp.code +otp.expiresAt');
  if (!user) return res.status(404).json({ success: false, message: 'Phone not found' });
  if (!user.matchOTP(otp)) return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
  user.isPhoneVerified = true;
  user.otp = undefined;
  user.lastLogin = new Date();
  await user.save();
  res.json({
    success: true,
    message: 'Login successful',
    data: { user: user.toJSON(), token: generateToken(user._id, user.role) },
  });
});

const register = asyncHandler(async (req, res) => {
  const { name, phone, email, password } = req.body;
  const exists = await User.findOne({ $or: [{ phone }, ...(email ? [{ email }] : [])] });
  if (exists) return res.status(409).json({ success: false, message: 'Phone or email already registered' });
  const user = await User.create({ name, phone, email, password });
  res.status(201).json({
    success: true,
    data: { user: user.toJSON(), token: generateToken(user._id, user.role) },
  });
});

const login = asyncHandler(async (req, res) => {
  const { phone, password } = req.body;
  const user = await User.findOne({ phone }).select('+password');
  if (!user || !(await user.matchPassword(password)))
    return res.status(401).json({ success: false, message: 'Invalid phone or password' });
  user.lastLogin = new Date();
  await user.save();
  res.json({
    success: true,
    data: { user: user.toJSON(), token: generateToken(user._id, user.role) },
  });
});

const getProfile = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).populate('addresses').populate('defaultAddress');
  res.json({ success: true, data: user });
});

const updateProfile = asyncHandler(async (req, res) => {
  const { name, email, vegOnly, avatar } = req.body;
  const user = await User.findById(req.user._id);
  if (name !== undefined)    user.name    = name;
  if (email !== undefined)   user.email   = email;
  if (vegOnly !== undefined) user.vegOnly = vegOnly;
  if (avatar !== undefined)  user.avatar  = avatar;
  await user.save();
  res.json({ success: true, data: user.toJSON() });
});

const getAddresses = asyncHandler(async (req, res) => {
  const addresses = await Address.find({ user: req.user._id }).sort({ isDefault: -1 });
  res.json({ success: true, count: addresses.length, data: addresses });
});

const addAddress = asyncHandler(async (req, res) => {
  const { tag, house, area, landmark, city, pincode, isDefault } = req.body;
  if (isDefault) await Address.updateMany({ user: req.user._id }, { isDefault: false });
  const address = await Address.create({
    user: req.user._id, tag, house, area, landmark, city, pincode,
    isDefault: !!isDefault,
  });
  await User.findByIdAndUpdate(req.user._id, {
    $push: { addresses: address._id },
    ...(isDefault && { defaultAddress: address._id }),
  });
  res.status(201).json({ success: true, data: address });
});

const updateAddress = asyncHandler(async (req, res) => {
  const address = await Address.findOne({ _id: req.params.id, user: req.user._id });
  if (!address) return res.status(404).json({ success: false, message: 'Address not found' });
  const fields = ['tag','house','area','landmark','city','pincode'];
  fields.forEach(f => { if (req.body[f] !== undefined) address[f] = req.body[f]; });
  if (req.body.isDefault) {
    await Address.updateMany({ user: req.user._id }, { isDefault: false });
    address.isDefault = true;
    await User.findByIdAndUpdate(req.user._id, { defaultAddress: address._id });
  }
  await address.save();
  res.json({ success: true, data: address });
});

const deleteAddress = asyncHandler(async (req, res) => {
  const address = await Address.findOne({ _id: req.params.id, user: req.user._id });
  if (!address) return res.status(404).json({ success: false, message: 'Address not found' });
  await address.deleteOne();
  await User.findByIdAndUpdate(req.user._id, {
    $pull: { addresses: address._id },
    ...(String(req.user.defaultAddress) === req.params.id && { defaultAddress: null }),
  });
  res.json({ success: true, message: 'Address deleted' });
});

const setDefaultAddress = asyncHandler(async (req, res) => {
  const address = await Address.findOne({ _id: req.params.id, user: req.user._id });
  if (!address) return res.status(404).json({ success: false, message: 'Address not found' });
  await Address.updateMany({ user: req.user._id }, { isDefault: false });
  address.isDefault = true;
  await address.save();
  await User.findByIdAndUpdate(req.user._id, { defaultAddress: address._id });
  res.json({ success: true, data: address });
});

module.exports = {
  sendOTPHandler, verifyOTPHandler, register, login,
  getProfile, updateProfile,
  getAddresses, addAddress, updateAddress, deleteAddress, setDefaultAddress,
};
            

'use strict';

const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const crypto = require('crypto');
const Order = require('../models/Order');
const Menu = require('../models/Menu');
const Restaurant = require('../models/Restaurant');
const Ledger = require('../models/SettlementLedger');
const PayoutRequest = require('../models/PayoutRequest');
const SupportTicket = require('../models/SupportTicket');
const { ACTIVE_ORDER_STATUSES, getRestaurantCapacity } = require('../services/vendorMarketplaceService');
const { commissionRateForDeliveryMode, commissionPlanForDeliveryMode } = require('../services/commissionService');

function assertVendor(req, res) {
  if (req.user?.role !== 'vendor' || !req.user.restaurantId) {
    res.status(403).json({ success: false, message: 'Vendor restaurant access required.' });
    return false;
  }
  return true;
}

function vendorRestaurantFilter(req) {
  return { _id: req.user.restaurantId, owner: req.user._id };
}

function publicPolicyVersions() {
  return {
    vendorAgreementVersion: String(process.env.VENDOR_AGREEMENT_VERSION || '2026-10-01'),
    vendorPrivacyPolicyVersion: String(process.env.VENDOR_PRIVACY_POLICY_VERSION || '2026-10-01'),
  };
}

function money(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

async function eligibleLedgerSummary(restaurantId, vendorId) {
  const rows = await Ledger.find({ restaurant: restaurantId, vendor: vendorId, status: 'eligible' }).select('netSettlementAmount').lean();
  return money(rows.reduce((sum, row) => sum + Math.max(0, Number(row.netSettlementAmount) || 0), 0));
}

exports.getVendorOnboardingConfig = asyncHandler(async (req, res) => {
  if (!assertVendor(req, res)) return;
  res.json({
    success: true,
    data: {
      businessTypes: ['restaurant', 'cloud_kitchen'],
      deliveryModes: [
        { key: 'self_delivery', label: 'Restaurant delivery', defaultCommissionRate: commissionRateForDeliveryMode('self_delivery') },
        { key: 'eatswada_rider', label: 'Eatswada rider delivery', defaultCommissionRate: commissionRateForDeliveryMode('eatswada_rider') },
      ],
      settlementSchedules: ['weekly', 'monthly'],
      maxActiveOrders: { min: 1, max: 500 },
      policies: publicPolicyVersions(),
    },
  });
});

exports.getVendorOperationalSettings = asyncHandler(async (req, res) => {
  if (!assertVendor(req, res)) return;
  const restaurant = await Restaurant.findOne(vendorRestaurantFilter(req));
  if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found.' });
  const capacity = await getRestaurantCapacity(restaurant._id);
  res.json({
    success: true,
    data: {
      restaurantId: restaurant._id,
      businessType: restaurant.businessType || 'restaurant',
      deliveryMode: restaurant.deliveryMode || 'eatswada_rider',
      commissionPlan: restaurant.commissionPlan || 'legacy',
      commissionRate: Number(restaurant.commissionRate) || 15,
      maxActiveOrders: capacity?.maxActiveOrders || restaurant.maxActiveOrders || 20,
      activeOrders: capacity?.activeOrders || 0,
      availableSlots: capacity?.availableSlots ?? 0,
      settlementSchedule: restaurant.settlementSchedule || 'weekly',
      joinDate: restaurant.createdAt,
      fssai: {
        licenseNumber: restaurant.fssaiLicenseNumber || '',
        certificateUrl: restaurant.fssaiCertificateUrl || '',
        expiryDate: restaurant.fssaiExpiryDate || null,
        verificationStatus: restaurant.fssaiVerificationStatus || 'pending',
      },
    },
  });
});

// Vendors may tune capacity and payout schedule, but not delivery ownership or
// commission. Those change the platform economics and must be admin-controlled.
exports.updateVendorOperationalSettings = asyncHandler(async (req, res) => {
  if (!assertVendor(req, res)) return;
  const restaurant = await Restaurant.findOne(vendorRestaurantFilter(req));
  if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found.' });

  const update = {};
  if (req.body?.maxActiveOrders !== undefined) {
    const cap = Number(req.body.maxActiveOrders);
    if (!Number.isInteger(cap) || cap < 1 || cap > 500) return res.status(400).json({ success: false, message: 'maxActiveOrders must be an integer between 1 and 500.' });
    update.maxActiveOrders = cap;
  }
  if (req.body?.settlementSchedule !== undefined) {
    if (!['weekly', 'monthly'].includes(req.body.settlementSchedule)) return res.status(400).json({ success: false, message: 'settlementSchedule must be weekly or monthly.' });
    update.settlementSchedule = req.body.settlementSchedule;
  }
  if (!Object.keys(update).length) return res.status(400).json({ success: false, message: 'No editable operational settings supplied.' });

  const updated = await Restaurant.findByIdAndUpdate(restaurant._id, { $set: update }, { new: true, runValidators: true });
  res.json({ success: true, data: updated, message: 'Vendor operational settings updated.' });
});

exports.getVendorCapacity = asyncHandler(async (req, res) => {
  if (!assertVendor(req, res)) return;
  const data = await getRestaurantCapacity(req.user.restaurantId);
  if (!data) return res.status(404).json({ success: false, message: 'Restaurant not found.' });
  res.json({ success: true, data: {
    restaurantId: data.restaurant._id,
    restaurantName: data.restaurant.name,
    maxActiveOrders: data.maxActiveOrders,
    activeOrders: data.activeOrders,
    availableSlots: data.availableSlots,
    activeStatuses: ACTIVE_ORDER_STATUSES,
  }});
});

// Vendor-created menu items become pending until an admin approves them.
exports.createVendorMenuItem = asyncHandler(async (req, res) => {
  if (!assertVendor(req, res)) return;
  const restaurant = await Restaurant.findOne(vendorRestaurantFilter(req)).select('_id');
  if (!restaurant) return res.status(404).json({ success: false, message: 'Restaurant not found.' });

  const name = String(req.body?.name || '').trim();
  const price = Number(req.body?.price);
  if (!name || !Number.isFinite(price) || price < 0) return res.status(400).json({ success: false, message: 'Menu name and a valid non-negative price are required.' });

  const item = await Menu.create({
    restaurantId: restaurant._id,
    name,
    description: String(req.body?.description || '').trim(),
    price,
    originalPrice: req.body?.originalPrice === '' || req.body?.originalPrice == null ? undefined : Number(req.body.originalPrice),
    image: typeof req.body?.image === 'string' ? req.body.image.trim() : undefined,
    isVeg: req.body?.isVeg !== false,
    category: String(req.body?.category || 'Main Course').trim(),
    isUnder99: price <= 99,
    isBestseller: false,
    isRecommended: false,
    inStock: req.body?.inStock !== false,
    customizations: Array.isArray(req.body?.customizations) ? req.body.customizations : [],
    sortOrder: Number.isFinite(Number(req.body?.sortOrder)) ? Number(req.body.sortOrder) : 0,
    approvalStatus: 'pending',
    createdBy: req.user._id,
  });
  res.status(201).json({ success: true, message: 'Menu item submitted for admin approval.', data: item });
});

exports.updateVendorMenuItem = asyncHandler(async (req, res) => {
  if (!assertVendor(req, res)) return;
  const item = await Menu.findOne({ _id: req.params.id, restaurantId: req.user.restaurantId, isActive: { $ne: false } });
  if (!item) return res.status(404).json({ success: false, message: 'Menu item not found or access denied.' });

  const inventoryOnlyKeys = new Set(['inStock', 'stockQuantity', 'trackStock', 'lowStockThreshold']);
  const body = req.body || {};
  const keys = Object.keys(body);
  const materialChange = keys.some(k => !inventoryOnlyKeys.has(k));
  const allowed = ['name','description','price','originalPrice','image','isVeg','category','customizations','sortOrder','inStock','stockQuantity','trackStock','lowStockThreshold'];
  for (const key of keys) if (!allowed.includes(key)) return res.status(400).json({ success:false, message:`Field not editable: ${key}` });

  for (const key of keys) item[key] = body[key];
  if (body.price !== undefined) item.isUnder99 = Number(item.price) <= 99;
  if (materialChange && item.approvalStatus === 'approved') {
    item.approvalStatus = 'pending';
    item.rejectionReason = '';
    item.reviewedBy = null;
    item.reviewedAt = null;
  }
  await item.save();
  res.json({ success:true, message: materialChange ? 'Menu change submitted for admin approval.' : 'Inventory updated.', data:item });
});

exports.deleteVendorMenuItem = asyncHandler(async (req, res) => {
  if (!assertVendor(req, res)) return;
  const item = await Menu.findOneAndUpdate(
    { _id: req.params.id, restaurantId: req.user.restaurantId },
    { $set: { isActive: false, inStock: false } },
    { new: true }
  );
  if (!item) return res.status(404).json({ success:false, message:'Menu item not found or access denied.' });
  res.json({ success:true, message:'Menu item removed from the customer menu.', data:item });
});

exports.setVendorInventory = asyncHandler(async (req, res) => {
  if (!assertVendor(req, res)) return;
  const item = await Menu.findOne({ _id: req.params.id, restaurantId: req.user.restaurantId, isActive: { $ne: false } });
  if (!item) return res.status(404).json({ success:false, message:'Menu item not found or access denied.' });

  const update = {};
  if (typeof req.body?.inStock === 'boolean') update.inStock = req.body.inStock;
  if (req.body?.stockQuantity !== undefined) {
    const qty = Number(req.body.stockQuantity);
    if (!Number.isFinite(qty) || qty < 0) return res.status(400).json({ success:false, message:'stockQuantity must be a non-negative number.' });
    update.stockQuantity = Math.floor(qty);
    update.inStock = qty > 0;
  }
  if (typeof req.body?.trackStock === 'boolean') update.trackStock = req.body.trackStock;
  if (req.body?.lowStockThreshold !== undefined) {
    const threshold = Number(req.body.lowStockThreshold);
    if (!Number.isFinite(threshold) || threshold < 0) return res.status(400).json({ success:false, message:'lowStockThreshold must be non-negative.' });
    update.lowStockThreshold = Math.floor(threshold);
  }
  if (!Object.keys(update).length) return res.status(400).json({ success:false, message:'No inventory fields supplied.' });

  const updated = await Menu.findByIdAndUpdate(item._id, { $set:update }, { new:true, runValidators:true });
  res.json({success:true, data:updated});
});

exports.verifySelfDeliveryOtp = asyncHandler(async (req, res) => {
  if (!assertVendor(req, res)) return;
  const restaurant = await Restaurant.findOne(vendorRestaurantFilter(req)).select('_id deliveryMode');
  if (!restaurant) return res.status(404).json({ success:false, message:'Restaurant not found.' });
  if ((restaurant.deliveryMode || 'eatswada_rider') !== 'self_delivery') return res.status(409).json({ success:false, message:'This restaurant uses Eatswada rider delivery. Use the rider workflow.' });

  const order = await Order.findOne({ _id:req.params.id, restaurant:restaurant._id, status:'out_for_delivery' })
    .select('+deliveryOtpHash +deliveryOtpSalt +deliveryOtpExpiresAt +deliveryOtpAttempts +deliveryOtpLockedUntil');
  if (!order) return res.status(404).json({success:false,message:'Self-delivery order not found or not ready for OTP verification.'});

  const result = order.verifyDeliveryOtp(req.body?.otp);
  if (!result.ok) {
    const code = result.reason === 'locked' || result.reason === 'locked_now' ? 429 : 400;
    return res.status(code).json({ success:false, message: result.reason === 'incorrect' || result.reason === 'locked_now' ? 'Incorrect delivery PIN.' : 'Delivery PIN is currently locked or unavailable.', ...result });
  }
  order.clearOtpSecrets();
  order.advanceStatus('otp_verified', 'Delivery PIN verified by restaurant self-delivery.');
  await order.save();
  res.json({success:true,message:'Delivery PIN verified. Order is ready to be marked delivered.',data:order});
});

exports.getVendorSettlementSummary = asyncHandler(async (req, res) => {
  if (!assertVendor(req, res)) return;
  const restaurant = await Restaurant.findOne(vendorRestaurantFilter(req)).select('_id settlementSchedule createdAt');
  if (!restaurant) return res.status(404).json({success:false,message:'Restaurant not found.'});
  const available = await eligibleLedgerSummary(restaurant._id, req.user._id);
  const activePayout = await PayoutRequest.findOne({ restaurant:restaurant._id, vendor:req.user._id, status:{ $in:['requested','processing'] } }).sort({createdAt:-1}).lean();
  res.json({success:true,data:{
    currency:'INR', settlementSchedule:restaurant.settlementSchedule || 'weekly', joinDate:restaurant.createdAt,
    eligibleBalance:available, availableForWithdrawal:activePayout ? 0 : available,
    activePayoutRequest:activePayout,
  }});
});

exports.listVendorWithdrawals = asyncHandler(async (req, res) => {
  if (!assertVendor(req, res)) return;
  const rows = await PayoutRequest.find({restaurant:req.user.restaurantId,vendor:req.user._id}).sort({createdAt:-1}).limit(100).lean();
  res.json({success:true,data:rows});
});

exports.requestVendorWithdrawal = asyncHandler(async (req, res) => {
  if (!assertVendor(req, res)) return;
  const restaurant = await Restaurant.findOne(vendorRestaurantFilter(req)).select('_id settlementSchedule');
  if (!restaurant) return res.status(404).json({success:false,message:'Restaurant not found.'});

  const hasRequestedAmount = req.body?.amount !== undefined && req.body?.amount !== '';
  const amount = hasRequestedAmount ? money(req.body?.amount) : null;
  if (hasRequestedAmount && (!Number.isFinite(amount) || amount <= 0)) return res.status(400).json({success:false,message:'Withdrawal amount must be a positive number.'});
  const pending = await PayoutRequest.exists({restaurant:restaurant._id,vendor:req.user._id,status:{ $in:['requested','processing'] }});
  if (pending) return res.status(409).json({success:false,message:'A payout request is already in progress.'});

  const eligibleRows = await Ledger.find({restaurant:restaurant._id,vendor:req.user._id,status:'eligible'})
    .select('_id netSettlementAmount')
    .sort({ eligibleAt:1, createdAt:1 })
    .lean();
  const eligible = money(eligibleRows.reduce((sum,r)=>sum+Math.max(0,Number(r.netSettlementAmount)||0),0));
  if (eligible <= 0) return res.status(409).json({success:false,message:'There is no eligible balance available for withdrawal.'});
  if (amount > eligible) return res.status(400).json({success:false,message:`Withdrawal exceeds eligible balance of ₹${eligible}.`});

  // Ledger entries are indivisible financial records. A withdrawal therefore
  // selects complete eligible entries whose sum exactly matches the requested
  // amount; omitting amount requests the full eligible balance.
  const requestedAmount = hasRequestedAmount ? amount : eligible;
  let running=0; const selected=[];
  for (const row of eligibleRows) {
    const rowAmount=Math.max(0,Number(row.netSettlementAmount)||0);
    if (rowAmount<=0) continue;
    if (running + rowAmount <= requestedAmount + 0.009) { selected.push(row._id); running=money(running+rowAmount); }
    if (Math.abs(running-requestedAmount)<0.01) break;
  }
  if (Math.abs(running-requestedAmount)>=0.01) {
    return res.status(400).json({success:false,message:'Requested amount cannot be formed from complete eligible settlement entries. Leave the amount blank to withdraw the full eligible balance.',data:{eligibleBalance:eligible,selectableAmount:running}});
  }

  const request = await PayoutRequest.create({
    vendor:req.user._id, restaurant:restaurant._id, amount:requestedAmount, ledgerEntries:selected, schedule:restaurant.settlementSchedule || 'weekly', status:'requested',
  });
  const reserved = await Ledger.updateMany({ _id:{ $in:selected }, restaurant:restaurant._id, vendor:req.user._id, status:'eligible' }, { $set:{ status:'reserved', payoutRequest:request._id } });
  if (reserved.modifiedCount !== selected.length) {
    await PayoutRequest.findByIdAndDelete(request._id);
    return res.status(409).json({success:false,message:'Settlement entries changed while the withdrawal was being created. Please try again.'});
  }

  res.status(201).json({success:true,message:'Withdrawal request created and settlement entries reserved. An admin/settlement process must complete the actual payout.',data:request});
});

exports.listVendorSupportTickets = asyncHandler(async (req,res)=>{
  if(!assertVendor(req,res))return;
  const rows=await SupportTicket.find({vendor:req.user._id,restaurant:req.user.restaurantId}).sort({createdAt:-1}).limit(100).lean();
  res.json({success:true,data:rows});
});

exports.createVendorSupportTicket = asyncHandler(async (req,res)=>{
  if(!assertVendor(req,res))return;
  const subject=String(req.body?.subject||'').trim(); const message=String(req.body?.message||'').trim();
  if(!subject||!message)return res.status(400).json({success:false,message:'subject and message are required.'});
  const category=['payment','order','delivery','customer_complaint','technical','account','document','policy','other'].includes(req.body?.category)?req.body.category:'other';
  const priority=['low','normal','high','urgent'].includes(req.body?.priority)?req.body.priority:'normal';
  let orderId=req.body?.orderId||null;
  if(orderId){
    if(!mongoose.isValidObjectId(orderId))return res.status(400).json({success:false,message:'Invalid orderId.'});
    const exists=await Order.exists({_id:orderId,restaurant:req.user.restaurantId}); if(!exists)return res.status(404).json({success:false,message:'Order not found for this restaurant.'});
  }
  const ticket=await SupportTicket.create({vendor:req.user._id,restaurant:req.user.restaurantId,order:orderId,category,priority,subject,messages:[{senderRole:'vendor',sender:req.user._id,message}]});
  res.status(201).json({success:true,message:'Support ticket created.',data:ticket});
});

exports.replyVendorSupportTicket=asyncHandler(async(req,res)=>{
  if(!assertVendor(req,res))return;
  const message=String(req.body?.message||'').trim(); if(!message)return res.status(400).json({success:false,message:'message is required.'});
  const ticket=await SupportTicket.findOne({_id:req.params.id,vendor:req.user._id,restaurant:req.user.restaurantId});
  if(!ticket)return res.status(404).json({success:false,message:'Support ticket not found.'});
  if(['resolved','closed'].includes(ticket.status))return res.status(409).json({success:false,message:'This ticket is already resolved/closed.'});
  ticket.messages.push({senderRole:'vendor',sender:req.user._id,message}); ticket.status='waiting_admin'; await ticket.save();
  res.json({success:true,data:ticket});
});

exports.getVendorPolicies=asyncHandler(async(req,res)=>{
  res.json({success:true,data:{...publicPolicyVersions(),note:'Policy documents should be served from the current approved legal content; these version identifiers are for acceptance/audit only.'}});
});

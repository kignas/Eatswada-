'use strict';
const mongoose=require('mongoose'); const Order=require('../models/Order'); const Restaurant=require('../models/Restaurant'); const User=require('../models/User'); const Ledger=require('../models/SettlementLedger'); const Batch=require('../models/SettlementBatch'); const RiderLedger=require('../models/RiderLedger');
const activePaidStatuses=['delivered'];
// Pillar 5: both prepaid UPI ('paid') and collected cash ('cod_collected')
// orders produce a vendor settlement entry, so the backfill and the integrity
// check must consider the same set the live delivery path uses.
const SETTLED_PAYMENT_STATUSES=['paid','cod_collected'];
function admin(req,res){if(req.user?.role!=='admin'){res.status(403).json({success:false,message:'Admin credentials required.'});return false}return true}
function snap(o){const c=o.commission||{};const food=Number(c.baseAmount)||Math.max(0,Number(o.subtotal)||0);const com=Number(c.amount)||Math.round(food*(Number(c.rate)||15))/100;const net=Number(c.restaurantNetAmount);return {food,rate:Number(c.rate)||15,com,net:Number.isFinite(net)?net:Math.max(0,food-com)};}
exports.rebuildLedger=async(req,res)=>{if(!admin(req,res))return;const session=await mongoose.startSession();try{const result=await session.withTransaction(async()=>{const orders=await Order.find({status:{$in:activePaidStatuses},paymentStatus:{$in:SETTLED_PAYMENT_STATUSES},restaurant:{$ne:null}}).select('restaurant user orderNumber subtotal commission refund').lean();let created=0;for(const o of orders){const exists=await Ledger.exists({order:o._id}).session(session);if(exists)continue;const r=await Restaurant.findById(o.restaurant).select('owner').session(session).lean();if(!r?.owner)continue;const s=snap(o);await Ledger.create([{restaurant:o.restaurant,vendor:r.owner,order:o._id,orderNumber:o.orderNumber,foodSales:s.food,commissionRate:s.rate,commissionAmount:s.com,restaurantNetAmount:s.net,netSettlementAmount:s.net,grossFoodBill:s.food,vendorDiscountShare:0,penaltyAdjustment:0,netVendorPayable:s.net,ledgerType:'vendor',source:'order_delivery',eligibleAt:new Date()}],{session});created++;}return created;});res.json({success:true,data:{created}})}finally{await session.endSession()}}
exports.listLedger=async(req,res)=>{if(!admin(req,res))return;const page=Math.max(1,Number(req.query.page)||1),limit=Math.min(100,Math.max(1,Number(req.query.limit)||25));const filter={};if(req.query.restaurantId&&mongoose.Types.ObjectId.isValid(req.query.restaurantId))filter.restaurant=req.query.restaurantId;if(req.query.status)filter.status=req.query.status;const [rows,total]=await Promise.all([Ledger.find(filter).populate('restaurant','name').populate('vendor','name email').sort({createdAt:-1}).skip((page-1)*limit).limit(limit).lean(),Ledger.countDocuments(filter)]);res.json({success:true,data:rows,pagination:{page,limit,total,pages:Math.ceil(total/limit)}})};
exports.settle=async(req,res)=>{
  if(!admin(req,res))return;
  const ids=Array.isArray(req.body?.ledgerIds)?req.body.ledgerIds.filter(mongoose.Types.ObjectId.isValid):[];
  if(!ids.length)return res.status(400).json({success:false,message:'ledgerIds are required.'});
  const session=await mongoose.startSession();
  try{
    let result;
    await session.withTransaction(async()=>{
      // Re-read inside the transaction and lock the exact eligible rows by
      // changing their state only after the batch is created. Concurrent admin
      // settlement requests therefore cannot both successfully settle the same
      // ledger entries.
      const rows=await Ledger.find({_id:{$in:ids},status:'eligible'}).session(session);
      if(!rows.length){const e=new Error('No eligible ledger entries found.');e.statusCode=409;throw e;}
      // Never settle a vendor's positive earnings while leaving an eligible
      // restaurant-caused cancellation charge behind.
      const groupsRequested=new Set(rows.map(r=>String(r.vendor)+'|'+String(r.restaurant)));
      const requiredAdjustments=await Ledger.find({status:'eligible',source:'restaurant_charge'}).session(session);
      for(const adj of requiredAdjustments){
        const key=String(adj.vendor)+'|'+String(adj.restaurant);
        if(groupsRequested.has(key) && !ids.some(id=>String(id)===String(adj._id))){
          const e=new Error('This vendor has an eligible restaurant cancellation charge. Include the charge adjustment in the settlement before paying out positive earnings.');e.statusCode=409;throw e;
        }
      }
      const byVendor=new Map();
      for(const r of rows){const k=String(r.vendor)+'|'+String(r.restaurant);if(!byVendor.has(k))byVendor.set(k,[]);byVendor.get(k).push(r)}
      const batches=[];
      for(const group of byVendor.values()){
        const amount=Math.round(group.reduce((a,r)=>a+Number(r.netSettlementAmount||0),0)*100)/100;
        if(amount < 0){const e=new Error('This vendor has a negative settlement balance. Add eligible positive earnings before settling the refund adjustment.');e.statusCode=409;throw e;}
        const b=await Batch.create([{restaurant:group[0].restaurant,vendor:group[0].vendor,ledgerEntries:group.map(r=>r._id),amount,status:'settled',reference:String(req.body.reference||'').slice(0,120),settledAt:new Date()}],{session});
        const batch=b[0];
        const update=await Ledger.updateMany({_id:{$in:group.map(r=>r._id)},status:'eligible'},{$set:{status:'settled',settlementBatch:batch._id,settledAt:batch.settledAt}}).session(session);
        if(update.modifiedCount!==group.length){const e=new Error('Settlement changed concurrently. Please refresh and try again.');e.statusCode=409;throw e;}
        batches.push(batch.toObject());
      }
      result={batches,count:batches.length};
    });
    res.json({success:true,data:result});
  }finally{await session.endSession()}
};

exports.integrity=async(req,res)=>{if(!admin(req,res))return;const delivered=await Order.find({status:'delivered',paymentStatus:{$in:SETTLED_PAYMENT_STATUSES}}).select('restaurant subtotal commission').lean();const led=await Ledger.find({status:{$ne:'void'}}).select('order netSettlementAmount commissionAmount').lean();const lm=new Map(led.map(x=>[String(x.order),x]));let missing=0,mismatch=0;for(const o of delivered){const l=lm.get(String(o._id));if(!l){missing++;continue}const s=snap(o);if(Math.abs(Number(l.netSettlementAmount)-s.net)>0.01||Math.abs(Number(l.commissionAmount)-s.com)>0.01)mismatch++}res.json({success:true,data:{deliveredOrders:delivered.length,ledgerEntries:led.length,missing,mismatch,healthy:missing===0&&mismatch===0}})};
exports.vendorLedger=async(req,res)=>{if(req.user?.role!=='vendor'||!req.user.restaurantId)return res.status(403).json({success:false,message:'Vendor restaurant access required.'});const rows=await Ledger.find({restaurant:req.user.restaurantId}).sort({createdAt:-1}).limit(200).lean();res.json({success:true,data:rows})};

// ─────────────────────────────────────────────────────────────────────
// Pillar 5/6 — Restaurant settlements + rider COD reconciliation console.
// All endpoints require finance.manage and are audited.
// ─────────────────────────────────────────────────────────────────────

const { getRestaurantSettlementStatement, getRiderBalance, recordCodCashDeposit, payRider } = require('../services/settlementService');
const { logAdminAction } = require('../services/auditService');
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

/** List every restaurant with its live unsettled settlement balance. */
exports.listRestaurantSettlements = async (req, res) => {
  if (!admin(req, res)) return;
  const rows = await Ledger.aggregate([
    { $match: { ledgerType: 'vendor', status: { $in: ['eligible', 'reserved'] } } },
    { $group: {
      _id: '$restaurant',
      unsettledBalance: { $sum: '$netVendorPayable' },
      grossFoodBill: { $sum: '$grossFoodBill' },
      commissionAmount: { $sum: '$commissionAmount' },
      vendorDiscountShare: { $sum: '$vendorDiscountShare' },
      penaltyAdjustment: { $sum: '$penaltyAdjustment' },
      orderCount: { $sum: 1 },
    } },
    { $lookup: { from: 'restaurants', localField: '_id', foreignField: '_id', as: 'restaurant' } },
    { $unwind: { path: '$restaurant', preserveNullAndEmptyArrays: true } },
    { $sort: { unsettledBalance: -1 } },
  ]);
  const data = rows.map(r => ({
    restaurantId: r._id,
    name: r.restaurant?.name || 'Unknown restaurant',
    image: r.restaurant?.image || '',
    commissionRate: r.restaurant?.commissionRate ?? null,
    unsettledBalance: round2(r.unsettledBalance),
    grossFoodBill: round2(r.grossFoodBill),
    commissionAmount: round2(r.commissionAmount),
    vendorDiscountShare: round2(r.vendorDiscountShare),
    penaltyAdjustment: round2(r.penaltyAdjustment),
    orderCount: r.orderCount,
  }));
  res.json({ success: true, data });
};

/** Itemized statement for one restaurant. */
exports.getRestaurantStatement = async (req, res) => {
  if (!admin(req, res)) return;
  const includeSettled = String(req.query.includeSettled || '') === 'true';
  const statement = await getRestaurantSettlementStatement(req.params.id, { includeSettled });
  if (!statement) return res.status(400).json({ success: false, message: 'A valid restaurantId is required.' });
  const restaurant = await Restaurant.findById(req.params.id).select('name image commissionRate').lean();
  res.json({ success: true, data: { ...statement, restaurant } });
};

/** Manual credit / debit adjustment on a restaurant's ledger. */
exports.createRestaurantAdjustment = async (req, res) => {
  if (!admin(req, res)) return;
  const restaurantId = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(restaurantId)) return res.status(400).json({ success: false, message: 'A valid restaurantId is required.' });
  const amount = round2(req.body?.amount);
  const direction = req.body?.direction === 'debit' ? -1 : 1;
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ success: false, message: 'amount must be greater than zero.' });
  const restaurant = await Restaurant.findById(restaurantId).select('owner name').lean();
  if (!restaurant?.owner) return res.status(404).json({ success: false, message: 'Restaurant or owner not found.' });
  const signed = round2(direction * amount);
  const doc = await Ledger.create({
    restaurant: restaurantId,
    vendor: restaurant.owner,
    order: new mongoose.Types.ObjectId(),
    orderNumber: '',
    foodSales: 0,
    commissionRate: 0,
    commissionAmount: 0,
    restaurantNetAmount: 0,
    adjustmentAmount: signed,
    netSettlementAmount: signed,
    grossFoodBill: 0,
    vendorDiscountShare: 0,
    penaltyAdjustment: signed,
    netVendorPayable: signed,
    ledgerType: 'vendor',
    source: 'restaurant_charge',
    note: String(req.body?.note || 'Manual adjustment').slice(0, 300),
  });
  await logAdminAction(req, { action: 'settlement.restaurant.adjustment', targetType: 'restaurant', targetId: restaurantId, targetLabel: restaurant.name, newValue: { amount: signed, note: req.body?.note || '' } });
  res.status(201).json({ success: true, data: doc });
};

/** Create a settlement batch and mark the chosen ledger entries paid (with UTR). */
exports.createSettlementBatch = async (req, res) => {
  if (!admin(req, res)) return;
  const suppliedIds = Array.isArray(req.body?.ledgerIds) ? req.body.ledgerIds : [];
  if (!suppliedIds.length) return res.status(400).json({ success: false, message: 'ledgerIds are required.' });
  if (suppliedIds.some(id => !mongoose.Types.ObjectId.isValid(id))) {
    return res.status(400).json({ success: false, message: 'Every ledgerIds entry must be a valid ID.' });
  }
  const ids = [...new Set(suppliedIds.map(String))];
  const reference = String(req.body?.reference || req.body?.bankUtr || '').trim().slice(0, 120);
  if (!reference) return res.status(400).json({ success: false, message: 'A bank UTR/reference is required to mark a batch paid.' });

  // A settlement batch pays ONE restaurant/vendor. The batch model itself
  // carries a single restaurant+vendor, so mixing restaurants here would
  // silently attribute one restaurant's money to another. Reject it up front.
  const preRows = await Ledger.find({ _id: { $in: ids }, status: 'eligible', ledgerType: 'vendor' })
    .select('restaurant vendor').lean();
  if (!preRows.length) return res.status(409).json({ success: false, message: 'No eligible ledger entries found.' });
  if (preRows.length !== ids.length) return res.status(409).json({ success: false, message: 'Every selected ledger entry must still be eligible for settlement. Refresh and select the entries again.' });
  const restaurant = preRows[0].restaurant;
  const vendor = preRows[0].vendor;
  if (preRows.some(r => String(r.restaurant) !== String(restaurant) || String(r.vendor) !== String(vendor))) {
    return res.status(400).json({ success: false, message: 'All ledger entries in a settlement batch must belong to the same restaurant and vendor.' });
  }

  // Wrap the batch creation + ledger updates in a transaction when supported so
  // a failure cannot leave a batch created but its entries still 'eligible'
  // (which would allow the same entries to be settled twice).
  const { withRequiredTransaction } = require('../services/dbTransaction');
  let outcome;
  try {
    outcome = await withRequiredTransaction(async (session) => {
      const rowsQuery = Ledger.find({ _id: { $in: ids }, status: 'eligible', ledgerType: 'vendor' });
      if (session) rowsQuery.session(session);
      const rows = await rowsQuery.lean();
      if (!rows.length || rows.length !== ids.length) { const e = new Error('Every selected ledger entry must still be eligible for settlement. Refresh and select the entries again.'); e.statusCode = 409; throw e; }
      if (rows.some(r => String(r.restaurant) !== String(restaurant) || String(r.vendor) !== String(vendor))) {
        const e = new Error('All ledger entries in a settlement batch must belong to the same restaurant and vendor.'); e.statusCode = 400; throw e;
      }
      const amount = round2(rows.reduce((sum, r) => sum + Number(r.netVendorPayable ?? r.netSettlementAmount ?? 0), 0));
      if (amount < 0) { const e = new Error('This vendor has a negative settlement balance. Add eligible positive earnings before paying out.'); e.statusCode = 409; throw e; }

      const batchDocs = await Batch.create([{
        restaurant, vendor, ledgerEntries: rows.map(r => r._id), amount,
        status: 'settled', reference, settledAt: new Date(),
      }], session ? { session } : undefined);
      const batch = batchDocs[0];

      const update = await Ledger.updateMany(
        { _id: { $in: rows.map(r => r._id) }, status: 'eligible' },
        { $set: { status: 'settled', settlementBatch: batch._id, settledAt: batch.settledAt } },
        session ? { session } : undefined
      );
      if (update.modifiedCount !== rows.length) {
        const e = new Error('Settlement changed concurrently. Please refresh and try again.'); e.statusCode = 409; throw e;
      }
      return { batch, count: rows.length, amount };
    });
  } catch (err) {
    const code = err?.statusCode || 500;
    if (code === 500) console.error(`[SETTLEMENT] batch create failed: ${err.message}`);
    return res.status(code).json({ success: false, message: err.message || 'Settlement failed.' });
  }

  await logAdminAction(req, { action: 'settlement.batch.create', targetType: 'restaurant', targetId: restaurant, targetLabel: String(restaurant), newValue: { batchId: outcome.batch._id, amount: outcome.amount, reference, entries: outcome.count } });
  res.status(201).json({ success: true, data: { batch: outcome.batch, count: outcome.count, amount: outcome.amount } });
};

/** CSV export of the vendor settlement ledger. */
exports.exportSettlementsCsv = async (req, res) => {
  if (!admin(req, res)) return;
  const filter = { ledgerType: 'vendor' };
  if (req.query.restaurantId && mongoose.Types.ObjectId.isValid(req.query.restaurantId)) filter.restaurant = req.query.restaurantId;
  if (['eligible', 'reserved', 'settled', 'void'].includes(req.query.status)) filter.status = req.query.status;
  const rows = await Ledger.find(filter).populate('restaurant', 'name').populate('vendor', 'name email').sort({ createdAt: -1 }).limit(5000).lean();
  const header = ['Order Number', 'Restaurant', 'Vendor', 'Gross Food Bill', 'Commission Rate', 'Commission Amount', 'Vendor Discount Share', 'Penalty Adjustment', 'Net Vendor Payable', 'Status', 'Settled At', 'Created At'];
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push([
      r.orderNumber, r.restaurant?.name || '', r.vendor?.name || r.vendor?.email || '',
      round2(r.grossFoodBill ?? r.foodSales), Number(r.commissionRate) || 0, round2(r.commissionAmount),
      round2(r.vendorDiscountShare), round2(r.penaltyAdjustment), round2(r.netVendorPayable ?? r.netSettlementAmount),
      r.status, r.settledAt ? new Date(r.settledAt).toISOString() : '', r.createdAt ? new Date(r.createdAt).toISOString() : '',
    ].map(csvCell).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="settlements-${Date.now()}.csv"`);
  res.send(lines.join('\n'));
};

/** Rider earnings + COD cash held + net payable, for every rider. */
exports.listRiderSettlements = async (req, res) => {
  if (!admin(req, res)) return;
  const riders = await User.find({ role: 'rider' }).select('name phone isActive riderDetails.cashInHand riderDetails.codCashLimit riderDetails.deliveryZone').sort({ name: 1 }).lean();
  const agg = await RiderLedger.aggregate([
    { $group: {
      _id: '$rider',
      totalEarnings: { $sum: { $cond: [{ $eq: ['$entryType', 'delivery_earning'] }, '$amount', 0] } },
      totalPayouts: { $sum: { $cond: [{ $eq: ['$entryType', 'payout'] }, '$amount', 0] } },
      totalAdjustments: { $sum: { $cond: [{ $eq: ['$entryType', 'adjustment'] }, '$amount', 0] } },
    } },
  ]);
  const byRider = new Map(agg.map(a => [String(a._id), a]));
  const data = riders.map(r => {
    const a = byRider.get(String(r._id)) || {};
    const totalEarnings = round2(a.totalEarnings || 0);
    const cashInHand = round2(r.riderDetails?.cashInHand || 0);
    return {
      riderId: r._id,
      name: r.name,
      phone: r.phone,
      isActive: r.isActive !== false,
      zone: r.riderDetails?.deliveryZone || '',
      totalEarnings,
      codCashHeld: cashInHand,
      codCashLimit: round2(r.riderDetails?.codCashLimit || 0),
      totalPayouts: round2(Math.abs(a.totalPayouts || 0)),
      totalAdjustments: round2(a.totalAdjustments || 0),
      netPayable: round2(totalEarnings - cashInHand + (a.totalAdjustments || 0) - Math.abs(a.totalPayouts || 0)),
    };
  });
  res.json({ success: true, data });
};

/** Record a rider's COD cash deposit (reduces cashInHand, audited). */
exports.recordRiderCodDeposit = async (req, res) => {
  if (!admin(req, res)) return;
  const amount = round2(req.body?.amount);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ success: false, message: 'amount must be greater than zero.' });
  const entry = await recordCodCashDeposit({
    riderId: req.params.id,
    amount,
    reference: req.body?.reference || req.body?.bankUtr || '',
    note: req.body?.note || '',
    adminId: req.user._id,
  });
  if (!entry) return res.status(409).json({ success: false, message: 'No COD cash is held by this rider, or the rider was not found.' });
  await logAdminAction(req, { action: 'settlement.rider.cod_deposit', targetType: 'rider', targetId: req.params.id, targetLabel: String(req.params.id), newValue: { amount: entry.codCashCollected, reference: entry.reference } });
  const balance = await getRiderBalance(req.params.id);
  res.status(201).json({ success: true, data: { entry, balance } });
};

/** Settle a rider payout with a bank/UPI UTR (audited). */
exports.settleRiderPayout = async (req, res) => {
  if (!admin(req, res)) return;
  const reference = String(req.body?.reference || req.body?.bankUtr || req.body?.utr || '').trim().slice(0, 120);
  if (!reference) return res.status(400).json({ success: false, message: 'A bank/UPI UTR reference is required.' });

  // The amount is optional (defaults to the full payable balance). When
  // supplied it must be a positive, finite number — a malformed value is
  // rejected rather than silently ignored, and it is capped at the
  // authoritative payable balance inside payRider (never trusted from the
  // client). A client-supplied idempotency key makes a retried payout safe.
  let requestedAmount = null;
  if (req.body?.amount !== undefined && req.body?.amount !== null && req.body?.amount !== '') {
    const requested = round2(req.body.amount);
    if (!Number.isFinite(requested) || requested <= 0) {
      return res.status(400).json({ success: false, message: 'amount must be a positive number.' });
    }
    requestedAmount = requested;
  }
  const token = String(req.body?.idempotencyKey || req.body?.payoutToken || '').trim().slice(0, 120) || undefined;

  const result = await payRider({
    riderId: req.params.id,
    requestedAmount,
    reference,
    note: req.body?.note || '',
    adminId: req.user._id,
    token,
  });

  if (!result.ok) {
    const status = result.reason === 'not_found' ? 404
      : result.reason === 'invalid_rider' ? 400
      : result.reason === 'invalid_amount' ? 400
      : 409;
    const message = {
      not_found: 'Rider not found.',
      invalid_rider: 'A valid riderId is required.',
      invalid_amount: 'amount must be a positive number.',
      no_balance: 'This rider has no positive payable balance to settle.',
      exceeds_balance: 'The requested payout exceeds the rider\'s payable balance.',
      duplicate: 'This payout was already recorded (duplicate request).',
      payout_in_progress: 'Another payout for this rider is being processed. Please retry shortly.',
    }[result.reason] || 'Payout could not be processed.';
    return res.status(status).json({ success: false, message, ...(result.balance ? { balance: result.balance } : {}) });
  }

  await logAdminAction(req, {
    action: 'settlement.rider.payout',
    targetType: 'rider',
    targetId: req.params.id,
    targetLabel: result.balance?.rider?.name || String(req.params.id),
    newValue: { amount: result.amount, reference, payoutToken: token || null },
  });
  res.status(201).json({ success: true, data: { entry: result.entry, balance: result.balance } });
};

/** Full rider ledger history (earnings, deposits, payouts, adjustments). */
exports.getRiderLedger = async (req, res) => {
  if (!admin(req, res)) return;
  const rows = await RiderLedger.find({ rider: req.params.id }).sort({ createdAt: -1 }).limit(500).lean();
  const balance = await getRiderBalance(req.params.id);
  if (!balance) return res.status(404).json({ success: false, message: 'Rider not found.' });
  res.json({ success: true, data: { balance, entries: rows } });
};


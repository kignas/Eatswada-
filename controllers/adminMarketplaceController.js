'use strict';

const asyncHandler = require('express-async-handler');
const PayoutRequest = require('../models/PayoutRequest');
const Ledger = require('../models/SettlementLedger');
const SupportTicket = require('../models/SupportTicket');
const Order = require('../models/Order');
const { createNotification } = require('../services/notificationService');
const { logAdminAction } = require('../services/auditService');
const {
  initiateSupportRefund,
  recordCodResolutionPayout,
  issueResolutionCoupon,
  applyFaultAttributionDeduction,
} = require('../services/refundService');
const { MAX_MESSAGES, cleanAttachments, escapeRegex, liveTypingRole, slaDueDates, SLA_MINUTES } = require('../utils/supportHelpers');

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function assertAdmin(req,res){
  if(req.user?.role!=='admin'){res.status(403).json({success:false,message:'Admin credentials required.'});return false;}
  return true;
}

exports.listPayoutRequests=asyncHandler(async(req,res)=>{
  if(!assertAdmin(req,res))return;
  const status=req.query.status; const filter={};
  if(['requested','processing','paid','rejected','cancelled'].includes(status))filter.status=status;
  const page=Math.max(1,Number(req.query.page)||1),limit=Math.min(100,Math.max(1,Number(req.query.limit)||25));
  const [rows,total]=await Promise.all([
    PayoutRequest.find(filter).populate('vendor','name email phone').populate('restaurant','name').sort({createdAt:-1}).skip((page-1)*limit).limit(limit).lean(),
    PayoutRequest.countDocuments(filter),
  ]);
  res.json({success:true,data:rows,pagination:{page,limit,total,pages:Math.ceil(total/limit)}});
});

exports.updatePayoutRequest=asyncHandler(async(req,res)=>{
  if(!assertAdmin(req,res))return;
  const request=await PayoutRequest.findById(req.params.id);
  if(!request)return res.status(404).json({success:false,message:'Payout request not found.'});
  const next=req.body?.status;
  if(!['processing','paid','rejected','cancelled'].includes(next))return res.status(400).json({success:false,message:'Invalid payout status.'});

  if(next==='paid'){
    if(request.status==='paid')return res.json({success:true,data:request});
    if(!['requested','processing'].includes(request.status))return res.status(409).json({success:false,message:'Only requested/processing payouts can be marked paid.'});
    const bankUtr=String(req.body?.bankUtr||req.body?.reference||'').trim().slice(0,120);
    if(!bankUtr)return res.status(400).json({success:false,message:'Bank UTR/reference is required before marking a payout paid.'});
    const entries=await Ledger.find({_id:{$in:request.ledgerEntries},payoutRequest:request._id,status:'reserved'}).select('_id netSettlementAmount').lean();
    const reconciledAmount=Math.round(entries.reduce((sum,row)=>sum+(Number(row.netSettlementAmount)||0),0)*100)/100;
    if(entries.length!==request.ledgerEntries.length || Math.abs(reconciledAmount-Number(request.amount))>=0.01)return res.status(409).json({success:false,message:'Payout ledger does not reconcile to the requested amount. No payout state was changed.',data:{expectedAmount:request.amount,ledgerAmount:reconciledAmount,expectedEntries:request.ledgerEntries.length,foundEntries:entries.length}});
    const updated=await Ledger.updateMany({_id:{$in:request.ledgerEntries},payoutRequest:request._id,status:'reserved'},{$set:{status:'settled',settledAt:new Date()}});
    if(updated.modifiedCount!==request.ledgerEntries.length)return res.status(409).json({success:false,message:'Not all reserved settlement entries are available. Reconcile the ledger before marking this payout paid.'});
    request.status='paid'; request.paidAt=new Date(); request.processedAt=new Date(); request.bankUtr=bankUtr; request.reference=request.bankUtr;
  } else if(next==='rejected' || next==='cancelled'){
    if(!['requested','processing'].includes(request.status))return res.status(409).json({success:false,message:'Only requested/processing payouts can be rejected or cancelled.'});
    await Ledger.updateMany({_id:{$in:request.ledgerEntries},payoutRequest:request._id,status:'reserved'},{$set:{status:'eligible'},$unset:{payoutRequest:''}});
    request.status=next; request.adminNote=String(req.body?.adminNote||'').trim().slice(0,500); request.processedAt=new Date();
  } else {
    if(!['requested','processing'].includes(request.status))return res.status(409).json({success:false,message:'Only requested payouts can move to processing.'});
    request.status='processing'; request.processedAt=new Date();
  }
  await request.save();
  res.json({success:true,data:request});
});

exports.getPayoutReconciliation=asyncHandler(async(req,res)=>{
  if(!assertAdmin(req,res))return;
  const request=await PayoutRequest.findById(req.params.id).populate('vendor','name email phone').populate('restaurant','name').lean();
  if(!request)return res.status(404).json({success:false,message:'Payout request not found.'});
  const entries=await Ledger.find({_id:{$in:request.ledgerEntries}}).sort({createdAt:1}).lean();
  const ledgerAmount=Math.round(entries.reduce((sum,row)=>sum+(Number(row.netSettlementAmount)||0),0)*100)/100;
  const allLinked=entries.length===request.ledgerEntries.length && entries.every(row=>String(row.payoutRequest||'')===String(request._id));
  res.json({success:true,data:{request,entries,reconciliation:{requestAmount:Number(request.amount),ledgerAmount,difference:Math.round((Number(request.amount)-ledgerAmount)*100)/100,entryCountExpected:request.ledgerEntries.length,entryCountFound:entries.length,allEntriesLinked:allLinked,amountMatches:Math.abs(Number(request.amount)-ledgerAmount)<0.01,canMarkPaid:allLinked&&Math.abs(Number(request.amount)-ledgerAmount)<0.01&&['requested','processing'].includes(request.status)}}});
});

exports.listSupportTickets=asyncHandler(async(req,res)=>{
  if(!assertAdmin(req,res))return;
  const filter={};
  if(['open','waiting_vendor','waiting_admin','waiting_customer','resolved','closed'].includes(req.query.status))filter.status=req.query.status;
  if(['low','normal','high','urgent'].includes(req.query.priority))filter.priority=req.query.priority;
  if(req.query.category)filter.category=String(req.query.category);
  // type=customer | vendor splits the two kinds of tickets.
  if(req.query.type==='customer')filter.customer={$ne:null};
  else if(req.query.type==='vendor')filter.vendor={$ne:null};
  // Agent inbox: assignedTo=me | unassigned | <userId>. Lets each operator see
  // only the conversations they own, and a shared unassigned queue.
  const assignedTo=String(req.query.assignedTo||'').trim();
  if(assignedTo==='me')filter.assignedTo=req.user._id;
  else if(assignedTo==='unassigned')filter.assignedTo=null;
  else if(assignedTo&&/^[a-f\d]{24}$/i.test(assignedTo))filter.assignedTo=assignedTo;
  // overdue=true surfaces tickets whose first-response SLA has already slipped.
  if(String(req.query.overdue||'')==='true'){filter.firstResponseAt=null;filter.firstResponseDueAt={$ne:null,$lt:new Date()};}
  // q searches by ticket number (e.g. EW-T-...).
  const q=String(req.query.q||'').trim().slice(0,60);
  if(q)filter.ticketNumber={$regex:escapeRegex(q),$options:'i'};
  const page=Math.max(1,Number(req.query.page)||1),limit=Math.min(100,Math.max(1,Number(req.query.limit)||25));
  const [rows,total]=await Promise.all([
    SupportTicket.find(filter).populate('vendor','name email phone').populate('customer','name email phone').populate('restaurant','name').populate('order','orderNumber status').populate('assignedTo','name email')
      .sort({updatedAt:-1}).skip((page-1)*limit).limit(limit).lean(),   // newest activity first
    SupportTicket.countDocuments(filter),
  ]);
  // Stamp SLA state per row so the console can colour the queue without extra calls.
  const now=Date.now();
  const withSla=rows.map(r=>{
    const agent=r.assignedTo&&typeof r.assignedTo==='object'?{id:r.assignedTo._id,name:r.assignedTo.name||'Agent'}:null;
    const overdueFirst=!r.firstResponseAt&&r.firstResponseDueAt&&new Date(r.firstResponseDueAt).getTime()<now;
    const overdueResolution=!['resolved','closed'].includes(r.status)&&r.resolutionDueAt&&new Date(r.resolutionDueAt).getTime()<now;
    return {...r,assignedTo:agent,typingRole:liveTypingRole(r),sla:{overdueFirstResponse:Boolean(overdueFirst),overdueResolution:Boolean(overdueResolution),firstResponseDueAt:r.firstResponseDueAt||null,resolutionDueAt:r.resolutionDueAt||null,firstResponseAt:r.firstResponseAt||null}};
  });
  res.json({success:true,data:withSla,pagination:{page,limit,total,pages:Math.ceil(total/limit)}});
});

exports.replySupportTicket=asyncHandler(async(req,res)=>{
  if(!assertAdmin(req,res))return;
  const message=String(req.body?.message||'').trim();
  if(!message)return res.status(400).json({success:false,message:'message is required.'});
  if(message.length>2000)return res.status(400).json({success:false,message:'message must be 2,000 characters or fewer.'});
  const attachments=cleanAttachments(req.body?.attachments);
  const base=await SupportTicket.findById(req.params.id).select('customer status firstResponseAt').lean();
  if(!base)return res.status(404).json({success:false,message:'Support ticket not found.'});
  if(base.status==='closed')return res.status(409).json({success:false,message:'Ticket is closed.'});

  const resolve=req.body?.resolve===true;
  const now=new Date();
  const set={status:resolve?'resolved':(base.customer?'waiting_customer':'waiting_vendor'),closedAt:resolve?now:null,typingRole:'',typingAt:null};
  if(['low','normal','high','urgent'].includes(req.body?.priority))set.priority=req.body.priority;
  // Stamp the first admin response once — this is the SLA clock that matters
  // most to the customer, so it is only ever set, never overwritten.
  if(!base.firstResponseAt)set.firstResponseAt=now;

  // Atomic push: a customer reply arriving at the same moment is never overwritten.
  const ticket=await SupportTicket.findOneAndUpdate(
    {_id:req.params.id,status:{$ne:'closed'},$expr:{$lt:[{$size:'$messages'},MAX_MESSAGES]}},
    {$push:{messages:{senderRole:'admin',sender:req.user._id,message,attachments,at:now}},$set:set},
    {new:true});
  if(!ticket)return res.status(409).json({success:false,message:'Ticket is closed or has reached its message limit.'});

  if(ticket.customer){ try { await createNotification({user:ticket.customer,type:'support',title:'Support replied',message:message.slice(0,180),data:{ticketId:String(ticket._id),ticketNumber:ticket.ticketNumber,orderId:ticket.order?String(ticket.order):''}}); } catch (_) {} }
  res.json({success:true,data:ticket});
});

// ── Pillar 4: production support & refund console ─────────────────────

const ISSUE_CATEGORIES = ['missing_item', 'wrong_item', 'spilled_packaging', 'quality_issue', 'late_delivery', 'payment_issue'];
const FAULT_TARGETS = ['vendor', 'rider', 'platform', 'none'];

function contextQuery(id) {
  return SupportTicket.findById(id)
    .populate('customer', 'name email phone isCodBlocked')
    .populate('restaurant', 'name owner')
    .populate('vendor', 'name email phone')
    .populate({
      path: 'order',
      select: 'orderNumber status paymentMethod paymentStatus subtotal deliveryFee total grandTotal bill items restaurantName pickupPhotoUrl pickupCode kptGamingFlag kptGamingNote riderWaitTimeMinutes rider riderReachedRestaurantAt orderReadyAt riderEarningBreakdown createdAt',
      populate: { path: 'rider', select: 'name phone riderDetails.cashInHand riderDetails.codCashLimit' },
    });
}

/**
 * Side-by-side resolution context: customer evidence vs. what the order and
 * the rider actually recorded. Read-only.
 */
exports.getSupportResolutionContext = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const ticket = await contextQuery(req.params.id).lean();
  if (!ticket) return res.status(404).json({ success: false, message: 'Support ticket not found.' });
  const order = ticket.order || null;
  res.json({
    success: true,
    data: {
      ticket,
      evidencePhotos: ticket.evidencePhotos || ticket.photos || [],
      issueCategory: ticket.issueCategory || null,
      order: order ? {
        _id: order._id,
        orderNumber: order.orderNumber,
        status: order.status,
        paymentMethod: order.paymentMethod,
        paymentStatus: order.paymentStatus,
        restaurantName: order.restaurantName,
        items: order.items || [],
        bill: order.bill || null,
        total: Number(order.grandTotal ?? order.total ?? 0),
        rider: order.rider || null,
        riderHandoff: {
          pickupPhotoUrl: order.pickupPhotoUrl || '',
          pickupCode: order.pickupCode || '',
          kptGamingFlag: order.kptGamingFlag === true,
          kptGamingNote: order.kptGamingNote || '',
          riderWaitTimeMinutes: Number(order.riderWaitTimeMinutes) || 0,
          riderReachedRestaurantAt: order.riderReachedRestaurantAt || null,
          orderReadyAt: order.orderReadyAt || null,
        },
      } : null,
      refundable: !!order && order.paymentMethod !== 'cod' && order.paymentStatus === 'paid' && order.supportRefund?.status !== 'completed',
      codResolution: !!order && order.paymentMethod === 'cod',
    },
  });
});

/**
 * 1-click resolution. Applies a refund (UPI) / payout or coupon (COD), and
 * records the fault attribution. All money actions are audited.
 *
 * Body:
 *   resolutionType: full_refund | partial_refund | coupon_issued | rejected
 *   refundAmount:   number (for partial_refund / coupon_issued value)
 *   faultAttribution: vendor | rider | platform | none
 *   note:           optional free text
 */
exports.resolveSupportTicket = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const ticket = await SupportTicket.findById(req.params.id);
  if (!ticket) return res.status(404).json({ success: false, message: 'Support ticket not found.' });
  if (ticket.status === 'closed') return res.status(409).json({ success: false, message: 'Ticket is closed.' });

  const resolutionType = String(req.body?.resolutionType || '').trim();
  if (!['full_refund', 'partial_refund', 'coupon_issued', 'rejected'].includes(resolutionType)) {
    return res.status(400).json({ success: false, message: 'Invalid resolutionType.' });
  }
  const faultAttribution = FAULT_TARGETS.includes(req.body?.faultAttribution) ? req.body.faultAttribution : (ticket.faultAttribution || 'none');
  const note = String(req.body?.note || '').trim().slice(0, 500);

  const order = ticket.order ? await Order.findById(ticket.order).select('paymentMethod paymentStatus total customer').lean() : null;
  let refundAmount = Number(req.body?.refundAmount);
  if (resolutionType === 'full_refund') refundAmount = order ? Number(order.total || 0) : 0;
  if (resolutionType === 'rejected') refundAmount = 0;
  if (!Number.isFinite(refundAmount) || refundAmount < 0) return res.status(400).json({ success: false, message: 'A valid refundAmount is required.' });
  if ((resolutionType === 'partial_refund' || resolutionType === 'coupon_issued') && refundAmount <= 0) {
    return res.status(400).json({ success: false, message: 'refundAmount must be greater than zero for this resolution.' });
  }

  const outcome = { refund: null, coupon: null, deduction: null, method: '' };

  if (resolutionType === 'full_refund' || resolutionType === 'partial_refund') {
    if (!order) return res.status(400).json({ success: false, message: 'This ticket is not linked to an order.' });
    if (String(order.paymentMethod || '').toLowerCase() === 'cod') {
      // COD: cash already collected; record a manual payout for the customer.
      const payout = await recordCodResolutionPayout(ticket.order, refundAmount, note || 'COD support resolution', req.user._id);
      outcome.refund = payout;
      outcome.method = payout.recorded ? 'cod_manual_payout' : `cod_${payout.skipped || 'skipped'}`;
    } else {
      const refund = await initiateSupportRefund(ticket.order, refundAmount, note || 'Support resolution', req.user._id);
      outcome.refund = refund;
      outcome.method = refund.refunded ? 'razorpay_refund' : `upi_${refund.skipped || refund.error || 'skipped'}`;
    }
  } else if (resolutionType === 'coupon_issued') {
    const coupon = await issueResolutionCoupon({
      amountRupees: refundAmount,
      customerId: ticket.customer,
      adminId: req.user._id,
      note,
    });
    outcome.coupon = coupon;
    outcome.method = coupon ? 'coupon' : 'coupon_failed';
  } else {
    outcome.method = 'rejected';
  }

  // Fault attribution deduction runs only when a refund/coupon was actually
  // granted (never on a rejection) and only for a real responsible party.
  if (resolutionType !== 'rejected' && faultAttribution !== 'none' && ticket.order && refundAmount > 0) {
    outcome.deduction = await applyFaultAttributionDeduction({
      orderId: ticket.order,
      target: faultAttribution,
      amountRupees: refundAmount,
      reason: `${resolutionType} — ${note || 'support resolution'}`,
      adminId: req.user._id,
    });
  }

  ticket.resolutionType = resolutionType;
  ticket.refundAmount = round2(refundAmount);
  ticket.faultAttribution = faultAttribution;
  ticket.status = 'resolved';
  ticket.closedAt = new Date();
  ticket.resolution = {
    resolvedBy: req.user._id,
    resolvedAt: new Date(),
    method: outcome.method,
    reference: String(outcome.refund?.refundId || outcome.coupon?.code || ''),
    note,
    ledgerDeduction: outcome.deduction ? {
      target: faultAttribution === 'platform' ? 'platform' : faultAttribution,
      amount: Number(outcome.deduction.amount) || 0,
      ledgerId: outcome.deduction.ledgerId || null,
    } : { target: '', amount: 0, ledgerId: null },
  };
  ticket.messages.push({
    senderRole: 'admin',
    sender: req.user._id,
    message: `Resolution: ${resolutionType.replace(/_/g, ' ')}${refundAmount > 0 ? ` of ₹${round2(refundAmount)}` : ''}. Fault: ${faultAttribution}.${note ? ` Note: ${note}` : ''}`,
    at: new Date(),
  });
  await ticket.save();

  if (ticket.customer) {
    try {
      await createNotification({
        user: ticket.customer,
        type: 'support',
        title: 'Support resolution',
        message: resolutionType === 'rejected' ? 'Your support request was reviewed.' : `Your support request was resolved (${resolutionType.replace(/_/g, ' ')}).`,
        data: { ticketId: String(ticket._id), ticketNumber: ticket.ticketNumber },
      });
    } catch (_) {}
  }

  await logAdminAction(req, {
    action: 'support.ticket.resolve',
    targetType: 'support_ticket',
    targetId: ticket._id,
    targetLabel: ticket.ticketNumber || String(ticket._id),
    newValue: { resolutionType, refundAmount: round2(refundAmount), faultAttribution, method: outcome.method },
  });

  res.json({ success: true, data: { ticket, outcome } });
});

/** Record/change fault attribution without resolving (audited). */
exports.setSupportFaultAttribution = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const faultAttribution = String(req.body?.faultAttribution || '').trim();
  if (!FAULT_TARGETS.includes(faultAttribution)) return res.status(400).json({ success: false, message: 'Invalid faultAttribution.' });
  const ticket = await SupportTicket.findByIdAndUpdate(req.params.id, { $set: { faultAttribution } }, { new: true });
  if (!ticket) return res.status(404).json({ success: false, message: 'Support ticket not found.' });
  await logAdminAction(req, { action: 'support.ticket.fault', targetType: 'support_ticket', targetId: ticket._id, targetLabel: ticket.ticketNumber || String(ticket._id), newValue: { faultAttribution } });
  res.json({ success: true, data: ticket });
});

/* ─────────────────────────────────────────────────────────────────────
 *  SUPPORT OPS (Pillar 4 / req 16)
 *  Agent assignment, live typing, and an SLA/quality scoreboard so support
 *  can be run like a real queue instead of a single shared inbox.
 * ───────────────────────────────────────────────────────────────────── */

// PATCH /api/admin/support/tickets/:id/assign  Body: { adminId|null, priority? }
exports.assignSupportTicket = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const ticket = await SupportTicket.findById(req.params.id).select('ticketNumber status priority firstResponseAt').lean();
  if (!ticket) return res.status(404).json({ success: false, message: 'Support ticket not found.' });

  const raw = req.body?.adminId;
  let assignedTo = null;
  if (raw && raw !== 'me') {
    if (!/^[a-f\d]{24}$/i.test(String(raw))) return res.status(400).json({ success: false, message: 'Invalid adminId.' });
    const agent = await require('../models/User').findOne({ _id: raw, role: 'admin', isActive: { $ne: false } }).select('_id').lean();
    if (!agent) return res.status(404).json({ success: false, message: 'Admin agent not found.' });
    assignedTo = agent._id;
  } else if (raw === 'me') {
    assignedTo = req.user._id;
  }

  const set = { assignedTo, assignedAt: assignedTo ? new Date() : null };
  // Re-prioritising an un-answered ticket re-bases its SLA clocks.
  if (['low', 'normal', 'high', 'urgent'].includes(req.body?.priority)) {
    set.priority = req.body.priority;
    if (!ticket.firstResponseAt) Object.assign(set, slaDueDates(req.body.priority));
  }

  const updated = await SupportTicket.findByIdAndUpdate(req.params.id, { $set: set }, { new: true })
    .populate('assignedTo', 'name email').lean();
  await logAdminAction(req, {
    action: 'support.ticket.assign', targetType: 'support_ticket', targetId: ticket._id,
    targetLabel: ticket.ticketNumber || String(ticket._id),
    newValue: { assignedTo: assignedTo ? String(assignedTo) : null, priority: set.priority || ticket.priority },
  });
  res.json({ success: true, data: updated });
});

// POST /api/admin/support/tickets/:id/typing  Body: { typing?: boolean }
exports.setSupportTyping = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const typing = req.body?.typing !== false;
  await SupportTicket.updateOne(
    { _id: req.params.id, status: { $ne: 'closed' } },
    { $set: { typingRole: typing ? 'admin' : '', typingAt: typing ? new Date() : null } },
    { timestamps: false }
  ).catch(() => {});
  res.json({ success: true, data: { typing: Boolean(typing) } });
});

// GET /api/admin/support/metrics?days=30
exports.getSupportMetrics = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const days = Math.min(180, Math.max(1, Number(req.query.days) || 30));
  const since = new Date(Date.now() - days * 86400000);
  const now = Date.now();
  const openStatuses = ['open', 'waiting_admin', 'waiting_vendor', 'waiting_customer'];

  const [byStatus, byPriority, totals, firstResponse, ratingAgg, assignedAgg, overdue] = await Promise.all([
    SupportTicket.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    SupportTicket.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: '$priority', count: { $sum: 1 } } }]),
    SupportTicket.countDocuments({ createdAt: { $gte: since } }),
    // Median-ish first-response time via average, in minutes, only for answered tickets.
    SupportTicket.aggregate([
      { $match: { createdAt: { $gte: since }, firstResponseAt: { $ne: null } } },
      { $project: { mins: { $divide: [{ $subtract: ['$firstResponseAt', '$createdAt'] }, 60000] } } },
      { $group: { _id: null, avgMinutes: { $avg: '$mins' }, answered: { $sum: 1 } } },
    ]),
    SupportTicket.aggregate([
      { $match: { createdAt: { $gte: since }, customerRating: { $ne: null } } },
      { $group: { _id: null, avgRating: { $avg: '$customerRating' }, rated: { $sum: 1 } } },
    ]),
    SupportTicket.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: '$assignedTo', count: { $sum: 1 } } },
    ]),
    SupportTicket.countDocuments({ status: { $in: openStatuses }, firstResponseAt: null, firstResponseDueAt: { $ne: null, $lt: new Date(now) } }),
  ]);

  const statusMap = Object.fromEntries(byStatus.map(r => [r._id, r.count]));
  const priorityMap = Object.fromEntries(byPriority.map(r => [r._id, r.count]));
  const openCount = openStatuses.reduce((n, s) => n + (statusMap[s] || 0), 0);
  const unassigned = await SupportTicket.countDocuments({ status: { $in: openStatuses }, assignedTo: null });

  res.json({
    success: true,
    data: {
      period: `${days}d`,
      totals: {
        tickets: totals,
        open: openCount,
        unassigned,
        overdueFirstResponse: overdue,
        resolved: (statusMap.resolved || 0) + (statusMap.closed || 0),
      },
      byStatus: statusMap,
      byPriority: priorityMap,
      firstResponse: firstResponse[0] || { avgMinutes: null, answered: 0 },
      customerSatisfaction: ratingAgg[0] || { avgRating: null, rated: 0 },
      byAgent: assignedAgg.map(r => ({ agentId: r._id, tickets: r.count })),
      slaPolicyMinutes: SLA_MINUTES,
    },
  });
});

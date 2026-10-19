'use strict';

const asyncHandler = require('express-async-handler');
const PayoutRequest = require('../models/PayoutRequest');
const Ledger = require('../models/SettlementLedger');
const SupportTicket = require('../models/SupportTicket');
const { createNotification } = require('../services/notificationService');
const { MAX_MESSAGES, cleanAttachments, escapeRegex } = require('../utils/supportHelpers');

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
    const updated=await Ledger.updateMany({_id:{$in:request.ledgerEntries},payoutRequest:request._id,status:'reserved'},{$set:{status:'settled',settledAt:new Date()}});
    if(updated.modifiedCount!==request.ledgerEntries.length)return res.status(409).json({success:false,message:'Not all reserved settlement entries are available. Reconcile the ledger before marking this payout paid.'});
    request.status='paid'; request.paidAt=new Date(); request.processedAt=new Date(); request.reference=String(req.body?.reference||'').trim().slice(0,120);
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

exports.listSupportTickets=asyncHandler(async(req,res)=>{
  if(!assertAdmin(req,res))return;
  const filter={};
  if(['open','waiting_vendor','waiting_admin','waiting_customer','resolved','closed'].includes(req.query.status))filter.status=req.query.status;
  if(['low','normal','high','urgent'].includes(req.query.priority))filter.priority=req.query.priority;
  if(req.query.category)filter.category=String(req.query.category);
  // type=customer | vendor splits the two kinds of tickets.
  if(req.query.type==='customer')filter.customer={$ne:null};
  else if(req.query.type==='vendor')filter.vendor={$ne:null};
  // q searches by ticket number (e.g. EW-T-...).
  const q=String(req.query.q||'').trim().slice(0,60);
  if(q)filter.ticketNumber={$regex:escapeRegex(q),$options:'i'};
  const page=Math.max(1,Number(req.query.page)||1),limit=Math.min(100,Math.max(1,Number(req.query.limit)||25));
  const [rows,total]=await Promise.all([
    SupportTicket.find(filter).populate('vendor','name email phone').populate('customer','name email phone').populate('restaurant','name').populate('order','orderNumber status')
      .sort({updatedAt:-1}).skip((page-1)*limit).limit(limit).lean(),   // newest activity first
    SupportTicket.countDocuments(filter),
  ]);
  res.json({success:true,data:rows,pagination:{page,limit,total,pages:Math.ceil(total/limit)}});
});

exports.replySupportTicket=asyncHandler(async(req,res)=>{
  if(!assertAdmin(req,res))return;
  const message=String(req.body?.message||'').trim();
  if(!message)return res.status(400).json({success:false,message:'message is required.'});
  if(message.length>2000)return res.status(400).json({success:false,message:'message must be 2,000 characters or fewer.'});
  const attachments=cleanAttachments(req.body?.attachments);
  const base=await SupportTicket.findById(req.params.id).select('customer status').lean();
  if(!base)return res.status(404).json({success:false,message:'Support ticket not found.'});
  if(base.status==='closed')return res.status(409).json({success:false,message:'Ticket is closed.'});

  const resolve=req.body?.resolve===true;
  const set={status:resolve?'resolved':(base.customer?'waiting_customer':'waiting_vendor'),closedAt:resolve?new Date():null};
  if(['low','normal','high','urgent'].includes(req.body?.priority))set.priority=req.body.priority;

  // Atomic push: a customer reply arriving at the same moment is never overwritten.
  const ticket=await SupportTicket.findOneAndUpdate(
    {_id:req.params.id,status:{$ne:'closed'},$expr:{$lt:[{$size:'$messages'},MAX_MESSAGES]}},
    {$push:{messages:{senderRole:'admin',sender:req.user._id,message,attachments,at:new Date()}},$set:set},
    {new:true});
  if(!ticket)return res.status(409).json({success:false,message:'Ticket is closed or has reached its message limit.'});

  if(ticket.customer){ try { await createNotification({user:ticket.customer,type:'support',title:'Support replied',message:message.slice(0,180),data:{ticketId:String(ticket._id),ticketNumber:ticket.ticketNumber,orderId:ticket.order?String(ticket.order):''}}); } catch (_) {} }
  res.json({success:true,data:ticket});
});

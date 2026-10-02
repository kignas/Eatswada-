'use strict';

const asyncHandler = require('express-async-handler');
const PayoutRequest = require('../models/PayoutRequest');
const Ledger = require('../models/SettlementLedger');
const SupportTicket = require('../models/SupportTicket');

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
  const filter={}; if(['open','waiting_vendor','waiting_admin','resolved','closed'].includes(req.query.status))filter.status=req.query.status;
  if(req.query.priority&&['low','normal','high','urgent'].includes(req.query.priority))filter.priority=req.query.priority;
  const page=Math.max(1,Number(req.query.page)||1),limit=Math.min(100,Math.max(1,Number(req.query.limit)||25));
  const [rows,total]=await Promise.all([SupportTicket.find(filter).populate('vendor','name email phone').populate('restaurant','name').populate('order','orderNumber status').sort({createdAt:-1}).skip((page-1)*limit).limit(limit).lean(),SupportTicket.countDocuments(filter)]);
  res.json({success:true,data:rows,pagination:{page,limit,total,pages:Math.ceil(total/limit)}});
});

exports.replySupportTicket=asyncHandler(async(req,res)=>{
  if(!assertAdmin(req,res))return;
  const message=String(req.body?.message||'').trim(); if(!message)return res.status(400).json({success:false,message:'message is required.'});
  const ticket=await SupportTicket.findById(req.params.id); if(!ticket)return res.status(404).json({success:false,message:'Support ticket not found.'});
  if(ticket.status==='closed')return res.status(409).json({success:false,message:'Ticket is closed.'});
  ticket.messages.push({senderRole:'admin',sender:req.user._id,message}); ticket.status=req.body?.resolve===true?'resolved':'waiting_vendor'; if(ticket.status==='resolved')ticket.closedAt=new Date(); await ticket.save();
  res.json({success:true,data:ticket});
});

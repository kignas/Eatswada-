'use strict';
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const SupportTicket = require('../models/SupportTicket');
const Order = require('../models/Order');
const Restaurant = require('../models/Restaurant');
const { createNotification } = require('../services/notificationService');

const CUSTOMER_CATEGORIES = new Set(['missing_item','wrong_item','food_quality','spilled_order','late_order','payment','refund','delivery','order','other']);
const idOk = (id) => mongoose.isValidObjectId(id);
const publicTicket = (ticket) => ticket;

exports.createTicket = asyncHandler(async (req, res) => {
  const orderId = String(req.body?.orderId || '').trim();
  const category = String(req.body?.category || 'other').trim();
  const subject = String(req.body?.subject || '').trim().slice(0,160);
  const message = String(req.body?.message || '').trim();
  const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments.slice(0,3).map(v=>String(v).trim()).filter(v=>/^https:\/\//i.test(v)).slice(0,3) : [];
  if (!idOk(orderId)) return res.status(400).json({success:false,message:'A valid orderId is required.'});
  if (!CUSTOMER_CATEGORIES.has(category)) return res.status(400).json({success:false,message:'Invalid support category.'});
  if (!message || message.length > 2000) return res.status(400).json({success:false,message:'Message is required and must be 2,000 characters or fewer.'});
  const order = await Order.findOne({_id:orderId,user:req.user._id}).select('_id orderNumber status restaurant restaurantName').lean();
  if (!order) return res.status(404).json({success:false,message:'Order not found for this account.'});
  // Prevent duplicate open tickets for the same customer/order/category.
  const existing = await SupportTicket.findOne({customer:req.user._id,order:order._id,category,status:{$in:['open','waiting_admin','waiting_vendor']}}).sort({createdAt:-1});
  if (existing) return res.status(200).json({success:true,data:existing,existing:true});
  const ticket = await SupportTicket.create({customer:req.user._id,order:order._id,restaurant:order.restaurant||null,category,priority:['late_order','missing_item','wrong_item','spilled_order'].includes(category)?'high':'normal',subject:subject || `${category.replace(/_/g,' ')} — order ${order.orderNumber||String(order._id).slice(-6)}`,status:'open',messages:[{senderRole:'user',sender:req.user._id,message,attachments}]});
  // Best-effort admin notification; ticket creation succeeds even if notification persistence is unavailable.
  try { await createNotification({user:req.user._id,type:'support',title:'Support request created',message:`Your support request ${ticket.ticketNumber} has been created.`,data:{ticketId:String(ticket._id),ticketNumber:ticket.ticketNumber,orderId:String(order._id)}}); } catch (_) {}
  return res.status(201).json({success:true,data:ticket});
});

exports.listMyTickets = asyncHandler(async(req,res)=>{
  const rows = await SupportTicket.find({customer:req.user._id}).populate('order','orderNumber status').populate('restaurant','name image').sort({updatedAt:-1}).limit(100).lean();
  res.json({success:true,data:rows});
});

exports.getMyTicket = asyncHandler(async(req,res)=>{
  if(!idOk(req.params.id)) return res.status(400).json({success:false,message:'Invalid ticket ID.'});
  const ticket=await SupportTicket.findOne({_id:req.params.id,customer:req.user._id}).populate('order','orderNumber status estimatedDelivery').populate('restaurant','name image').lean();
  if(!ticket)return res.status(404).json({success:false,message:'Support ticket not found.'});
  res.json({success:true,data:ticket});
});

exports.replyMyTicket = asyncHandler(async(req,res)=>{
  if(!idOk(req.params.id)) return res.status(400).json({success:false,message:'Invalid ticket ID.'});
  const message=String(req.body?.message||'').trim();
  if(!message || message.length>2000)return res.status(400).json({success:false,message:'Message is required and must be 2,000 characters or fewer.'});
  const attachments=Array.isArray(req.body?.attachments)?req.body.attachments.slice(0,3).map(v=>String(v).trim()).filter(v=>/^https:\/\//i.test(v)).slice(0,3):[];
  const ticket=await SupportTicket.findOne({_id:req.params.id,customer:req.user._id});
  if(!ticket)return res.status(404).json({success:false,message:'Support ticket not found.'});
  if(['closed','resolved'].includes(ticket.status))return res.status(409).json({success:false,message:'This ticket is resolved or closed. Create a new request if you still need help.'});
  ticket.messages.push({senderRole:'user',sender:req.user._id,message,attachments});
  ticket.status='waiting_admin'; ticket.closedAt=null; await ticket.save();
  res.json({success:true,data:ticket});
});

exports.closeMyTicket = asyncHandler(async(req,res)=>{
  if(!idOk(req.params.id)) return res.status(400).json({success:false,message:'Invalid ticket ID.'});
  const ticket=await SupportTicket.findOne({_id:req.params.id,customer:req.user._id});
  if(!ticket)return res.status(404).json({success:false,message:'Support ticket not found.'});
  ticket.status='closed';ticket.closedAt=new Date();await ticket.save();
  res.json({success:true,data:ticket});
});

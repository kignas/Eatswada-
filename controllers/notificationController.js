'use strict'; const Notification=require('../models/Notification');
exports.list=async(req,res)=>{const rows=await Notification.find({user:req.user._id}).sort({createdAt:-1}).limit(100).lean();res.json({success:true,data:rows})};
exports.markRead=async(req,res)=>{const n=await Notification.findOneAndUpdate({_id:req.params.id,user:req.user._id},{$set:{readAt:new Date()}},{new:true});if(!n)return res.status(404).json({success:false,message:'Notification not found.'});res.json({success:true,data:n})};

exports.acknowledgeAdminNewOrders=async(req,res)=>{const now=new Date();const result=await Notification.updateMany({user:req.user._id,type:'order','data.kind':'admin_new_order',readAt:null},{$set:{readAt:now}});res.json({success:true,data:{acknowledged:result.modifiedCount||0}})};

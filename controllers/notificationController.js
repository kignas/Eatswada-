'use strict'; const Notification=require('../models/Notification');
exports.list=async(req,res)=>{const rows=await Notification.find({user:req.user._id}).sort({createdAt:-1}).limit(100).lean();res.json({success:true,data:rows})};
exports.markRead=async(req,res)=>{const n=await Notification.findOneAndUpdate({_id:req.params.id,user:req.user._id},{$set:{readAt:new Date()}},{new:true});if(!n)return res.status(404).json({success:false,message:'Notification not found.'});res.json({success:true,data:n})};

'use strict';
const mongoose=require('mongoose'); const Setting=require('../models/PlatformSetting'); const Zone=require('../models/DeliveryZone');
function admin(req,res){if(req.user?.role!=='admin'){res.status(403).json({success:false,message:'Admin credentials required.'});return false}return true}
exports.getSettings=async(req,res)=>{if(!admin(req,res))return;const rows=await Setting.find().lean();res.json({success:true,data:Object.fromEntries(rows.map(x=>[x.key,x.value]))})};
exports.setSetting=async(req,res)=>{if(!admin(req,res))return;const key=String(req.body?.key||'').trim();if(!/^[a-zA-Z0-9_.-]{2,80}$/.test(key))return res.status(400).json({success:false,message:'Invalid setting key.'});const s=await Setting.findOneAndUpdate({key},{$set:{value:req.body.value,updatedBy:req.user._id}},{upsert:true,new:true,setDefaultsOnInsert:true});res.json({success:true,data:s})};
exports.listZones=async(req,res)=>{if(!admin(req,res))return;res.json({success:true,data:await Zone.find().sort({name:1}).lean()})};
exports.createZone=async(req,res)=>{if(!admin(req,res))return;const z=await Zone.create(req.body);res.status(201).json({success:true,data:z})};
exports.updateZone=async(req,res)=>{if(!admin(req,res))return;const z=await Zone.findByIdAndUpdate(req.params.id,{$set:req.body},{new:true,runValidators:true});if(!z)return res.status(404).json({success:false,message:'Delivery zone not found.'});res.json({success:true,data:z})};
exports.deleteZone=async(req,res)=>{if(!admin(req,res))return;const z=await Zone.findByIdAndDelete(req.params.id);if(!z)return res.status(404).json({success:false,message:'Delivery zone not found.'});res.json({success:true,message:'Delivery zone deleted.'})};

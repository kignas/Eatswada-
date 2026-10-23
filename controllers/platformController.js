'use strict';
const mongoose=require('mongoose'); const Setting=require('../models/PlatformSetting'); const Zone=require('../models/DeliveryZone');
const { getPlatformSettings, updatePlatformConfig, billPolicyFrom } = require('../services/platformSettingsService');
const { logAdminAction } = require('../services/auditService');
function admin(req,res){if(req.user?.role!=='admin'){res.status(403).json({success:false,message:'Admin credentials required.'});return false}return true}
exports.getSettings=async(req,res)=>{if(!admin(req,res))return;const rows=await Setting.find().lean();res.json({success:true,data:Object.fromEntries(rows.map(x=>[x.key,x.value]))})};
exports.setSetting=async(req,res)=>{if(!admin(req,res))return;const key=String(req.body?.key||'').trim();if(!/^[a-zA-Z0-9_.-]{2,80}$/.test(key))return res.status(400).json({success:false,message:'Invalid setting key.'});const s=await Setting.findOneAndUpdate({key},{$set:{value:req.body.value,updatedBy:req.user._id}},{upsert:true,new:true,setDefaultsOnInsert:true});res.json({success:true,data:s})};

/* ── Pillar 1/2/3/6 — structured platform configuration ───────────────
 * GET  /platform/config  → the merged, validated platform configuration
 * PUT  /platform/config  → patch one or more registry keys atomically
 * Both require settings.manage and are audited.
 */
exports.getPlatformConfig=async(req,res)=>{
  if(!admin(req,res))return;
  const settings=await getPlatformSettings();
  res.json({success:true,data:settings});
};
exports.updatePlatformConfig=async(req,res)=>{
  if(!admin(req,res))return;
  const patch=req.body?.settings && typeof req.body.settings==='object' ? req.body.settings : req.body;
  if(!patch || typeof patch!=='object' || Array.isArray(patch))return res.status(400).json({success:false,message:'A settings object is required.'});
  const before=await getPlatformSettings();
  const {updated,skipped,settings}=await updatePlatformConfig(patch,req.user._id);
  if(!Object.keys(updated).length)return res.status(400).json({success:false,message:'No valid platform settings were supplied.',skipped});
  await logAdminAction(req,{action:'platform.config.update',targetType:'platform',targetId:null,targetLabel:'Platform configuration',oldValue:Object.fromEntries(Object.keys(updated).map(k=>[k,before[k]])),newValue:updated});
  res.json({success:true,data:{updated,skipped,settings}});
};
/* Customer-facing, read-only snapshot. Whitelisted keys only — rider pay,
 * auto-breaker internals and every admin-only setting stay private. */
const PUBLIC_STATUS_KEYS=['isUnderMaintenance','maintenanceTitle','maintenanceMessage','maintenanceEta','isDeliveryPausedShortage','shortageBannerMessage','isRainSurgeActive','rainSurgeFee','rainExtraEtaMinutes','isGlobalFreeDelivery','freeDeliveryMinSubtotal','isFirstOrderFreeDelivery','platformHandlingFee','smallCartThreshold','smallCartFee','packagingChargePerItem','taxPercent','isUpiEnabled','isCodEnabled','maxCodOrderAmount','codAdvanceThreshold','codAdvancePercent','codDisplayLabel'];
exports.getPublicStatus=async(req,res)=>{
  const settings=await getPlatformSettings();
  const data={};for(const k of PUBLIC_STATUS_KEYS)data[k]=settings[k];
  if(req.user&&req.user.role==='user'){
    const Order=require('../models/Order');const User=require('../models/User');
    const [hasOrder,u]=await Promise.all([Order.exists({user:req.user._id}),User.findById(req.user._id).select('isCodBlocked accountStatus codPolicy').lean()]);
    data.isFirstOrder=!hasOrder;data.isCodBlocked=u?.isCodBlocked===true;
    // A frozen or COD-blocked account still browses, but checkout is refused;
    // expose the state so the UI can explain why instead of failing at submit.
    data.isAccountFrozen=u?.accountStatus==='frozen';
    // Per-customer COD terms override the platform default for this user only.
    if(Number.isFinite(Number(u?.codPolicy?.advancePercent)))data.codAdvancePercent=Number(u.codPolicy.advancePercent);
    if(Number.isFinite(Number(u?.codPolicy?.advanceRequiredAbove)))data.codAdvanceThreshold=Number(u.codPolicy.advanceRequiredAbove);
  }
  res.set('Cache-Control','no-store');
  res.json({success:true,data});
};
/* Bill/delivery pricing policy view for the Admin pricing controller card. */
exports.getBillPolicy=async(req,res)=>{
  if(!admin(req,res))return;
  const settings=await getPlatformSettings();
  res.json({success:true,data:{settings,billPolicy:billPolicyFrom(settings)}});
};
exports.listZones=async(req,res)=>{if(!admin(req,res))return;res.json({success:true,data:await Zone.find().sort({name:1}).lean()})};
exports.createZone=async(req,res)=>{if(!admin(req,res))return;const z=await Zone.create(req.body);res.status(201).json({success:true,data:z})};
exports.updateZone=async(req,res)=>{if(!admin(req,res))return;const z=await Zone.findByIdAndUpdate(req.params.id,{$set:req.body},{new:true,runValidators:true});if(!z)return res.status(404).json({success:false,message:'Delivery zone not found.'});res.json({success:true,data:z})};
exports.deleteZone=async(req,res)=>{if(!admin(req,res))return;const z=await Zone.findByIdAndDelete(req.params.id);if(!z)return res.status(404).json({success:false,message:'Delivery zone not found.'});res.json({success:true,message:'Delivery zone deleted.'})};

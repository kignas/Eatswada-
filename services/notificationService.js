'use strict';
const Notification=require('../models/Notification');
const pushService=require('./pushService');

const notifyOrderStatus=async(userId,order)=>{
  const messages={
    confirmed:['Order confirmed',`Your order #${order.orderNumber} has been confirmed.`],
    preparing:['Order preparing',`${order.restaurantName} is preparing your order.`],
    out_for_delivery:['Order on the way','Your order is on the way.'],
    delivered:['Order delivered','Your order was delivered. Enjoy your meal!'],
    cancelled:['Order cancelled',`Order #${order.orderNumber} was cancelled.`]
  };
  const m=messages[order.status]; if(!m)return null;
  try{pushService.pushToUser(userId,{type:'order_update',title:m[0],body:m[1],orderId:String(order._id),orderNumber:String(order.orderNumber||''),status:order.status}).catch(()=>{});}catch(_){}
  try{return await Notification.create({user:userId,type:'order',title:m[0],message:m[1],data:{orderId:String(order._id),orderNumber:order.orderNumber,status:order.status}})}
  catch(err){console.error('[NOTIFY] persistence failed:',err.message);return null}
};

const notifyDeliveryIssue=async(order)=>{
  const reason=String(order.deliveryIssue?.reason||'a delivery issue');
  const note=String(order.deliveryIssue?.note||'').trim();
  const body=note
    ? `Your delivery partner reported: ${reason}. ${note}`
    : `Your delivery partner reported: ${reason}. We are working to complete your delivery.`;
  try{pushService.pushToUser(order.user,{
    type:'delivery_issue',
    title:'Delivery update',
    body,
    orderId:String(order._id),
    orderNumber:String(order.orderNumber||''),
    reasonCode:String(order.deliveryIssue?.reasonCode||''),
  }).catch(()=>{});}catch(_){}
  try{return await Notification.create({
    user:order.user, type:'order', title:'Delivery update', message:body,
    data:{orderId:String(order._id),orderNumber:order.orderNumber,kind:'delivery_issue',reasonCode:order.deliveryIssue?.reasonCode||'',reason:reason,note:note}
  })}catch(err){console.error('[NOTIFY] delivery issue persistence failed:',err.message);return null}
};

const notifyRiderAssignment=async(order,rider)=>{
  if(!rider?._id)return null;
  const body=`New delivery ${order.orderNumber||'#'+String(order._id).slice(-6).toUpperCase()} · ${order.restaurantName||'Restaurant'}`;
  try{pushService.pushToUser(rider._id,{
    type:'rider_assignment',title:'New delivery assigned',body,
    orderId:String(order._id),orderNumber:String(order.orderNumber||''),
    riderStatus:'assigned'
  }).catch(()=>{});}catch(_){}
  try{return await Notification.create({
    user:rider._id,type:'order',title:'New delivery assigned',message:body,
    data:{orderId:String(order._id),orderNumber:order.orderNumber||'',kind:'rider_assignment'}
  })}catch(err){console.error('[NOTIFY] rider assignment persistence failed:',err.message);return null}
};

const createNotification=async({user,type='system',title,message,data={}})=>Notification.create({user,type,title,message,data});
module.exports={notifyOrderStatus,notifyDeliveryIssue,notifyRiderAssignment,createNotification};

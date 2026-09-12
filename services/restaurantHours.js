'use strict';
const DAYS=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
function validTime(v){return typeof v==='string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)}
function isOpenByHours(restaurant, now=new Date()){
 const day=restaurant?.openingHours?.[DAYS[now.getDay()]];
 if(!day || day.closed) return false;
 if(!validTime(day.opensAt)||!validTime(day.closesAt)) return true;
 const mins=now.getHours()*60+now.getMinutes(); const a=Number(day.opensAt.slice(0,2))*60+Number(day.opensAt.slice(3)); const b=Number(day.closesAt.slice(0,2))*60+Number(day.closesAt.slice(3));
 return a===b ? true : (a<b ? mins>=a&&mins<b : mins>=a||mins<b);
}
function operationalStatus(r,now=new Date()){
 if(r?.availability?.status==='temporarily_closed'||r?.availability?.status==='closed_today'||r?.availability?.closedReason==='temporarily_closed'||r?.availability?.closedReason==='closed_today') return {open:false,status:r.availability.status||r.availability.closedReason};
 if(r?.availability?.status==='busy') return {open:true,status:'busy'};
 if(r?.availability?.autoHours) return {open:isOpenByHours(r,now),status:isOpenByHours(r,now)?'open':'closed_today'};
 return {open:r?.availability?.isOpen !== false && r?.isOpen !== false,status:'open'};
}
module.exports={DAYS,validTime,isOpenByHours,operationalStatus};

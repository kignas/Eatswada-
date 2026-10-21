'use strict';
const Menu = require('../models/Menu');
let timer = null;
let running = false;
async function recoverScheduledRestocks() {
  if (running) return { modifiedCount: 0 };
  running = true;
  try {
    return await Menu.updateMany(
      { inStock: false, autoTurnOnAt: { $ne: null, $lte: new Date() }, isActive: { $ne: false } },
      { $set: { inStock: true, autoTurnOnAt: null } }
    );
  } finally { running = false; }
}
function startMenuStockScheduler(intervalMs = 60000) {
  if (timer) return timer;
  recoverScheduledRestocks().catch(err => console.error('[menu-stock] startup recovery failed:', err.message));
  timer = setInterval(() => recoverScheduledRestocks().catch(err => console.error('[menu-stock] recovery failed:', err.message)), intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}
module.exports = { startMenuStockScheduler, recoverScheduledRestocks };

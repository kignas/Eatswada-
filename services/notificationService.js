/**
 * notificationService.js
 * Stub for push notifications / SMS order alerts.
 * Replace with Firebase FCM or any push provider.
 */

const notifyOrderStatus = async (userId, order) => {
  const messages = {
    confirmed:          `✅ Your order #${order.orderNumber} has been confirmed!`,
    preparing:          `👨‍🍳 ${order.restaurantName} is preparing your order.`,
    out_for_delivery:   `🛵 Your order is on the way!`,
    delivered:          `🎉 Order delivered! Enjoy your meal.`,
    cancelled:          `❌ Order #${order.orderNumber} was cancelled.`,
  };
  const msg = messages[order.status];
  if (msg) console.log(`[NOTIFY] User ${userId}: ${msg}`);
  // TODO: integrate FCM / OneSignal / SMS here
};

module.exports = { notifyOrderStatus };

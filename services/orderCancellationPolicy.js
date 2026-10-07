'use strict';

const CUSTOMER_CANCEL_WINDOW_MS = 30 * 1000;
const RESTAURANT_RESPONSE_WINDOW_MS = 5 * 60 * 1000;

function deadlinesFrom(createdAt = new Date()) {
  const created = new Date(createdAt);
  return {
    customerCancellationDeadline: new Date(created.getTime() + CUSTOMER_CANCEL_WINDOW_MS),
    restaurantResponseDeadline: new Date(created.getTime() + RESTAURANT_RESPONSE_WINDOW_MS),
  };
}

function isWithinCustomerCancellationWindow(order, now = new Date()) {
  if (!order || order.status !== 'placed') return false;
  if (order.isCancellable === false) return false;
  const deadline = order.customerCancellationDeadline ? new Date(order.customerCancellationDeadline) : new Date(new Date(order.createdAt).getTime() + CUSTOMER_CANCEL_WINDOW_MS);
  return now.getTime() <= deadline.getTime();
}

function isRestaurantResponseOverdue(order, now = new Date()) {
  if (!order || order.status !== 'placed') return false;
  const deadline = order.restaurantResponseDeadline ? new Date(order.restaurantResponseDeadline) : null;
  return !!deadline && now.getTime() >= deadline.getTime();
}

module.exports = {
  CUSTOMER_CANCEL_WINDOW_MS,
  RESTAURANT_RESPONSE_WINDOW_MS,
  deadlinesFrom,
  isWithinCustomerCancellationWindow,
  isRestaurantResponseOverdue,
};

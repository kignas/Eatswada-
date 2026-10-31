'use strict';

/**
 * Authoritative menu-item price resolver shared by quote generation and order
 * creation. All option labels are validated against the current Menu document;
 * option prices are never accepted from the client.
 *
 * Compatibility is intentional: both the legacy flat label array and the
 * newer group-aware selection formats remain supported exactly as before.
 */
function calculateItemServerPrice(menuItem, requestedCustomizations) {
  let basePrice = Number(menuItem?.price) || 0;
  let extraTotal = 0;
  let portionPrice = null;
  const selectedByGroup = {};
  const legacySelectedLabels = new Set();
  const entries = Array.isArray(requestedCustomizations)
    ? requestedCustomizations
    : (requestedCustomizations && typeof requestedCustomizations === 'object'
      ? Object.entries(requestedCustomizations).map(([title, value]) => ({ title, selected: Array.isArray(value) ? value : [value] }))
      : []);

  for (const entry of entries) {
    if (typeof entry === 'string' || typeof entry === 'number') {
      const label = String(entry).trim();
      if (label) legacySelectedLabels.add(label);
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const title = String(entry.title || '');
    if (!title) continue;
    let labels = [];
    if (Array.isArray(entry.selected)) labels = entry.selected.map(String);
    else if (Array.isArray(entry.options)) labels = entry.options.map(o => String(o && o.label != null ? o.label : o));
    else if (entry.label != null) labels = [String(entry.label)];
    selectedByGroup[title] = [...(selectedByGroup[title] || []), ...labels];
  }

  for (const group of (Array.isArray(menuItem?.customizations) ? menuItem.customizations : [])) {
    const title = String(group.title || '');
    const options = Array.isArray(group.options) ? group.options : [];
    const legacyLabelsForGroup = options
      .filter(option => legacySelectedLabels.has(String(option.label)))
      .map(option => String(option.label));
    const labels = [...(selectedByGroup[title] || []), ...legacyLabelsForGroup];

    if (group.pricingMode === 'portion' && labels.length > 1) {
      const err = new Error(`Please choose only one portion for "${title}".`);
      err.statusCode = 400;
      throw err;
    }
    for (const label of labels) {
      const option = options.find(o => String(o.label) === String(label));
      if (!option) {
        const err = new Error(`Invalid option "${label}" for "${title}".`);
        err.statusCode = 400;
        throw err;
      }
      const optionPrice = Math.max(0, Number(option.extraPrice || 0));
      if (group.pricingMode === 'portion') portionPrice = optionPrice;
      else extraTotal += optionPrice;
    }
  }

  basePrice = portionPrice == null ? basePrice : portionPrice;
  return Math.round((basePrice + extraTotal) * 100) / 100;
}

module.exports = { calculateItemServerPrice };

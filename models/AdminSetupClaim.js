'use strict';

const mongoose = require('mongoose');

// Singleton claim that serializes the one-time public admin bootstrap. The
// MongoDB _id index is unique by definition; the record remains after a
// successful bootstrap so re-enabling the endpoint cannot provision another
// initial administrator. Only release it when a pre-creation attempt fails.
const schema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    createdAt: { type: Date, default: Date.now, immutable: true },
  },
  { collection: 'admin_setup_claims', versionKey: false }
);

module.exports = mongoose.models.AdminSetupClaim || mongoose.model('AdminSetupClaim', schema);

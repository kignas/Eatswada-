'use strict';

const mongoose = require('mongoose');

/**
 * Run `work` inside a single MongoDB multi-document transaction when the
 * deployment supports it, and fall back to a plain (non-transactional) run
 * when it does not.
 *
 * Transactions require a replica set or sharded cluster. A standalone
 * `mongod` (the usual local/dev setup) rejects `startSession`/transactions,
 * so callers that must remain correct on both topologies use this helper:
 *
 *   - On a replica set the callback is retried/aborted as one atomic unit, so
 *     a failure leaves no partial writes behind.
 *   - On a standalone the callback still runs, but each write commits on its
 *     own. Callers therefore MUST design the work to be idempotent and safe
 *     under concurrency (conditional updates, unique indexes, pre-generated
 *     ids) so a non-transactional failure is still recoverable rather than
 *     silently corrupting money.
 *
 * `work(session)` receives a session to pass to every query, or `null` when no
 * transaction is available. The callback's return value is returned to the
 * caller.
 */
async function withOptionalTransaction(work) {
  let session = null;
  try {
    session = await mongoose.startSession();
  } catch (err) {
    // No session support at all — run without a transaction.
    return work(null);
  }

  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });
    return result;
  } catch (err) {
    if (isTransactionUnsupported(err)) {
      return work(null);
    }
    throw err;
  } finally {
    try { await session.endSession(); } catch (_) { /* already ended */ }
  }
}

function isTransactionUnsupported(err) {
  const message = String(err?.message || '');
  return err?.code === 20 // IllegalOperation
    || err?.codeName === 'IllegalOperation'
    || /Transaction numbers are only allowed on a replica set member or mongos/i.test(message)
    || /Transactions are not supported/i.test(message)
    || /This MongoDB deployment does not support retryable writes/i.test(message)
    || /does not support transactions/i.test(message);
}

/**
 * Run a financial multi-document operation only when MongoDB transactions are
 * available. Unlike withOptionalTransaction, this helper NEVER reruns work
 * without a transaction: doing so could commit only part of a money movement.
 */
async function withRequiredTransaction(work) {
  let session;
  try {
    session = await mongoose.startSession();
  } catch (err) {
    const unavailable = new Error('This financial operation requires MongoDB transaction support. Use a replica set or sharded cluster; no changes were made.');
    unavailable.statusCode = 503;
    unavailable.code = 'TRANSACTION_REQUIRED';
    unavailable.cause = err;
    throw unavailable;
  }

  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });
    return result;
  } catch (err) {
    if (isTransactionUnsupported(err)) {
      const unavailable = new Error('This financial operation requires MongoDB transaction support. Use a replica set or sharded cluster; no changes were made.');
      unavailable.statusCode = 503;
      unavailable.code = 'TRANSACTION_REQUIRED';
      unavailable.cause = err;
      throw unavailable;
    }
    throw err;
  } finally {
    try { await session.endSession(); } catch (_) { /* already ended */ }
  }
}

module.exports = { withOptionalTransaction, withRequiredTransaction, isTransactionUnsupported };

const mongoose = require('mongoose');
const perfDiagnostics = require('../utils/perfDiagnostics');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI, {
      // The load test reaches more concurrent HTTP requests than the old 10-connection
      // default could serve without queueing. Keep this env-configurable so staging/
      // production can tune it independently.
      maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE) || 30,
      minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE) || 2,
      serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS) || 10000,
      socketTimeoutMS: Number(process.env.MONGO_SOCKET_TIMEOUT_MS) || 45000,
      connectTimeoutMS: Number(process.env.MONGO_CONNECT_TIMEOUT_MS) || 10000,
      // Only with PERF_DIAGNOSTICS=true: lets utils/perfDiagnostics.js time
      // each MongoDB command. Off by default (same options as before).
      ...(perfDiagnostics.enabled ? { monitorCommands: true } : {}),
    });

    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);

    mongoose.connection.on('disconnected', () => {
      console.warn('⚠️  MongoDB disconnected. Attempting reconnect...');
    });

    mongoose.connection.on('reconnected', () => {
      console.log('✅ MongoDB reconnected');
    });

  } catch (error) {
    console.error(`❌ MongoDB connection error: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
  

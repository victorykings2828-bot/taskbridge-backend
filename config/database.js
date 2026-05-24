const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      maxPoolSize: parseInt(process.env.MAX_DB_CONNECTIONS) || 10,
    });
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);

    // One-time migration: drop the legacy GLOBAL unique index on email so that
    // the same email can exist in multiple organizations. The new per-org
    // compound index ({email, organizationId}) is created automatically by the
    // User schema. Safe to run repeatedly — ignored once the index is gone.
    try {
      await conn.connection.collection('users').dropIndex('email_1');
      console.log('🔧 Dropped legacy global email_1 unique index');
    } catch (e) {
      if (e.codeName !== 'IndexNotFound' && e.code !== 27) {
        console.log('ℹ️  email_1 index drop skipped:', e.message);
      }
    }
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    process.exit(1);
  }
};

module.exports = connectDB;

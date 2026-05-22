require('dotenv').config({ path: './.env' });
const mongoose = require('mongoose');
const User = require('../src/models/User');

const seedSuperAdmin = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    const existing = await User.findOne({ role: 'super_admin' });
    if (existing) {
      console.log('⚠️  Super Admin already exists:', existing.email);
      process.exit(0);
    }

    const superAdmin = await User.create({
      name: 'Super Admin',
      email: 'superadmin@company.com',
      password: 'SuperAdmin@123',
      role: 'super_admin',
      isFirstLogin: false,
    });

    console.log('✅ Super Admin created successfully!');
    console.log('   Email:    superadmin@company.com');
    console.log('   Password: SuperAdmin@123');
    console.log('   ⚠️  Change this password immediately in production!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Seed error:', error.message);
    process.exit(1);
  }
};

seedSuperAdmin();

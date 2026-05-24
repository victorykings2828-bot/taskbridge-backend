// One-off admin script to comp a plan to a company (no payment).
//
// Usage (from the taskbridge-backend folder):
//   node scripts/grant-plan.js <email> [pro|enterprise|free]
//
// MONGODB_URI must point at the SAME database the app uses. If you don't have a
// local .env, pass it inline. Examples:
//   PowerShell:  $env:MONGODB_URI="<your atlas uri>"; node scripts/grant-plan.js victorykings2828@gmail.com pro
//   bash:        MONGODB_URI="<your atlas uri>" node scripts/grant-plan.js victorykings2828@gmail.com pro
//
// It finds the super-admin account(s) for the email and upgrades their
// organization. subscriptionExpiresAt is set to null, so the grant does NOT
// auto-expire (it's a permanent comp until you change it).

const dns = require('dns');
if (dns.setDefaultResultOrder) dns.setDefaultResultOrder('ipv4first');
try { require('dotenv').config(); } catch (_) {}

const mongoose     = require('mongoose');
const User         = require('../src/models/User');
const Organization = require('../src/models/Organization');

(async () => {
  const email = (process.argv[2] || '').toLowerCase().trim();
  const tier  = (process.argv[3] || 'pro').toLowerCase().trim();

  if (!email) {
    console.error('Usage: node scripts/grant-plan.js <email> [pro|enterprise|free]');
    process.exit(1);
  }
  if (!['free', 'pro', 'enterprise'].includes(tier)) {
    console.error(`Invalid tier "${tier}". Use: free | pro | enterprise`);
    process.exit(1);
  }
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set. Pass it inline (see the comment at the top of this file).');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB.');

  const accounts = await User.find({ email });
  if (accounts.length === 0) {
    console.error(`No user found with email ${email}.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  // Upgrade the organization for each account where this person is the owner.
  const owners = accounts.filter((u) => u.role === 'super_admin');
  const targets = owners.length > 0 ? owners : accounts;

  let changed = 0;
  for (const acct of targets) {
    if (!acct.organizationId) continue;
    const org = await Organization.findById(acct.organizationId);
    if (!org) continue;

    org.subscriptionTier      = tier;
    org.subscriptionStatus    = tier === 'free' ? 'active' : 'active';
    org.subscriptionExpiresAt = null; // permanent comp — won't auto-expire
    org.applyTierLimits();
    await org.save();
    await User.updateMany({ organizationId: org._id }, { subscriptionTier: tier });

    changed++;
    console.log(`✅ "${org.name}" is now on the ${tier.toUpperCase()} plan. Limits:`, org.limits);
  }

  if (changed === 0) console.log('Nothing changed (no organization found for that email).');
  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});

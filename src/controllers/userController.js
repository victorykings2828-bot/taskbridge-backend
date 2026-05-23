const User = require('../models/User');
const Organization = require('../models/Organization');
const AuditLog = require('../models/AuditLog');
const Notification = require('../models/Notification');
const { sendWelcomeEmail } = require('../utils/email');

// Generate a strong temp password
const generateTempPassword = () => {
  const upper   = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower   = 'abcdefghjkmnpqrstuvwxyz';
  const digits  = '23456789';
  const special = '@#$!';
  const all     = upper + lower + digits + special;
  const rand    = (set) => set[Math.floor(Math.random() * set.length)];
  const required = [rand(upper), rand(lower), rand(digits), rand(special)];
  const rest = Array.from({ length: 8 }, () => rand(all));
  return [...required, ...rest].sort(() => Math.random() - 0.5).join('');
};

// POST /api/users
const createUser = async (req, res) => {
  try {
    const { name, email, role, department, phone } = req.body;
    const creator = req.user;

    if (!name || !email || !role) {
      return res.status(400).json({ success: false, message: 'Name, email, and role are required' });
    }

    // Role permission check
    if (creator.role === 'super_admin' && !['manager', 'employee'].includes(role)) {
      return res.status(403).json({ success: false, message: 'Super Admin can only create Managers or Employees' });
    }
    if (creator.role === 'manager' && role !== 'employee') {
      return res.status(403).json({ success: false, message: 'Manager can only create Employees' });
    }

    // Must belong to an org
    if (!creator.organizationId) {
      return res.status(400).json({ success: false, message: 'You must belong to an organisation to create users' });
    }

    // Subscription limits
    const org = await Organization.findById(creator.organizationId);
    if (!org) {
      return res.status(404).json({ success: false, message: 'Organisation not found' });
    }

    if (role === 'manager') {
      const managerCount = await User.countDocuments({ organizationId: org._id, role: 'manager', isActive: true });
      if (managerCount >= org.limits.managers) {
        return res.status(403).json({
          success: false,
          message: `Your ${org.subscriptionTier} plan allows max ${org.limits.managers} manager(s). Upgrade to add more.`,
          upgradeRequired: true,
        });
      }
    }

    if (role === 'employee') {
      const empCount = await User.countDocuments({ organizationId: org._id, role: 'employee', isActive: true });
      if (empCount >= org.limits.totalEmployees) {
        return res.status(403).json({
          success: false,
          message: `Your ${org.subscriptionTier} plan allows max ${org.limits.totalEmployees} employees. Upgrade to add more.`,
          upgradeRequired: true,
        });
      }
      if (creator.role === 'manager') {
        const underManager = await User.countDocuments({ managerId: creator._id, organizationId: org._id, role: 'employee', isActive: true });
        if (underManager >= org.limits.employeesPerManager) {
          return res.status(403).json({
            success: false,
            message: `You have reached the limit of ${org.limits.employeesPerManager} employees. Upgrade to add more.`,
            upgradeRequired: true,
          });
        }
      }
    }

    const existing = await User.findOne({ email: email.toLowerCase().trim() });
    if (existing) {
      return res.status(409).json({ success: false, message: 'An account with this email already exists' });
    }

    const tempPassword = generateTempPassword();

    const newUser = await User.create({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password: tempPassword,
      role,
      department: department || '',
      phone: phone || '',
      createdBy: creator._id,
      managerId: creator.role === 'manager' ? creator._id : null,
      organizationId: creator.organizationId,
      subscriptionTier: org.subscriptionTier || 'free',
      isFirstLogin: true,
    });

    // Try to send welcome email — don't fail if email not configured
    try { await sendWelcomeEmail(newUser, tempPassword); } catch (e) { console.log('Email not sent (not configured):', e.message); }

    await Notification.create({
      recipient: newUser._id,
      type: 'account_created',
      title: 'Welcome to TaskBridge',
      message: `Your account has been created by ${creator.name}. Use these credentials to log in.`,
    });

    await AuditLog.create({
      performedBy: creator._id,
      action: 'USER_CREATED',
      targetModel: 'User',
      targetId: newUser._id,
      details: { email: newUser.email, role: newUser.role },
      ipAddress: req.ip,
    });

    res.status(201).json({
      success: true,
      message: `${role.charAt(0).toUpperCase() + role.slice(1)} created successfully`,
      user: newUser,
      tempPassword, // Always return so admin can share manually
    });
  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).json({ success: false, message: 'Failed to create user: ' + error.message });
  }
};

// GET /api/users — scoped to org
const getUsers = async (req, res) => {
  try {
    const requester = req.user;
    let query = { organizationId: requester.organizationId };

    if (requester.role === 'super_admin') {
      query.role = 'manager';
    } else if (requester.role === 'manager') {
      query.role = 'employee';
      query.managerId = requester._id;
    } else {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const users = await User.find(query).select('-password -refreshTokens').sort({ createdAt: -1 });
    res.json({ success: true, users });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch users' });
  }
};

// GET /api/users/:id
const getUserById = async (req, res) => {
  try {
    const user = await User.findOne({
      _id: req.params.id,
      organizationId: req.user.organizationId,
    }).select('-password -refreshTokens');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const requester = req.user;
    if (requester.role === 'employee' && requester._id.toString() !== req.params.id) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    if (
      requester.role === 'manager' &&
      requester._id.toString() !== req.params.id &&
      (user.role !== 'employee' || user.managerId?.toString() !== requester._id.toString())
    ) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch user' });
  }
};

// PUT /api/users/:id
const updateUser = async (req, res) => {
  try {
    const { name, department, phone, isActive } = req.body;
    const user = await User.findOne({
      _id: req.params.id,
      organizationId: req.user.organizationId,
    });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (
      req.user.role === 'manager' &&
      (user.role !== 'employee' || user.managerId?.toString() !== req.user._id.toString())
    ) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    if (name) user.name = name;
    if (department !== undefined) user.department = department;
    if (phone !== undefined) user.phone = phone;
    if (isActive !== undefined && req.user.role !== 'employee') user.isActive = isActive;

    await user.save();

    await AuditLog.create({
      performedBy: req.user._id,
      action: 'USER_UPDATED',
      targetModel: 'User',
      targetId: user._id,
      details: { updatedFields: Object.keys(req.body) },
      ipAddress: req.ip,
    });

    res.json({ success: true, message: 'User updated successfully', user });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update user' });
  }
};

// GET /api/users/stats — dashboard stats scoped to org
const getDashboardStats = async (req, res) => {
  try {
    const requester = req.user;
    const Task = require('../models/Task');
    const orgId = requester.organizationId;

    if (requester.role === 'super_admin') {
      const [totalManagers, totalEmployees, totalTasks, completedTasks, inProgressTasks, overdueTasks, underReviewTasks, recentActivity] = await Promise.all([
        User.countDocuments({ organizationId: orgId, role: 'manager', isActive: true }),
        User.countDocuments({ organizationId: orgId, role: 'employee', isActive: true }),
        Task.countDocuments({ organizationId: orgId }),
        Task.countDocuments({ organizationId: orgId, status: 'completed' }),
        Task.countDocuments({ organizationId: orgId, status: 'in_progress' }),
        Task.countDocuments({ organizationId: orgId, status: 'overdue' }),
        Task.countDocuments({ organizationId: orgId, status: 'under_review' }),
        Task.find({ organizationId: orgId }).sort({ createdAt: -1 }).limit(10)
          .populate('assignedTo', 'name').populate('assignedBy', 'name')
          .select('title status priority deadline assignedTo assignedBy createdAt'),
      ]);

      return res.json({
        success: true,
        stats: { totalManagers, totalEmployees, totalTasks, completedTasks, inProgressTasks, overdueTasks, underReviewTasks },
        recentActivity,
      });
    }

    if (requester.role === 'manager') {
      const [totalEmployees, totalTasks, completedTasks, pendingTasks, overdueTasks, underReviewTasks] = await Promise.all([
        User.countDocuments({ managerId: requester._id, organizationId: orgId, role: 'employee', isActive: true }),
        Task.countDocuments({ assignedBy: requester._id, organizationId: orgId }),
        Task.countDocuments({ assignedBy: requester._id, organizationId: orgId, status: 'completed' }),
        Task.countDocuments({ assignedBy: requester._id, organizationId: orgId, status: { $in: ['not_started', 'in_progress'] } }),
        Task.countDocuments({ assignedBy: requester._id, organizationId: orgId, deadline: { $lt: new Date() }, status: { $nin: ['completed', 'cancelled'] } }),
        Task.countDocuments({ assignedBy: requester._id, organizationId: orgId, status: 'under_review' }),
      ]);

      return res.json({
        success: true,
        stats: { totalEmployees, totalTasks, completedTasks, pendingTasks, overdueTasks, underReviewTasks },
      });
    }

    if (requester.role === 'employee') {
      const [totalTasks, completedTasks, inProgressTasks, overdueTasks, notStartedTasks] = await Promise.all([
        Task.countDocuments({ assignedTo: requester._id, organizationId: orgId }),
        Task.countDocuments({ assignedTo: requester._id, organizationId: orgId, status: 'completed' }),
        Task.countDocuments({ assignedTo: requester._id, organizationId: orgId, status: 'in_progress' }),
        Task.countDocuments({ assignedTo: requester._id, organizationId: orgId, deadline: { $lt: new Date() }, status: { $nin: ['completed', 'cancelled'] } }),
        Task.countDocuments({ assignedTo: requester._id, organizationId: orgId, status: 'not_started' }),
      ]);

      return res.json({
        success: true,
        stats: { totalTasks, completedTasks, inProgressTasks, overdueTasks, notStartedTasks },
      });
    }
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch dashboard stats' });
  }
};

module.exports = { createUser, getUsers, getUserById, updateUser, getDashboardStats };

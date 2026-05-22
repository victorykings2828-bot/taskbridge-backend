const User = require('../models/User');
const Organization = require('../models/Organization');
const AuditLog = require('../models/AuditLog');
const Notification = require('../models/Notification');
const { sendWelcomeEmail } = require('../utils/email');
const { v4: uuidv4 } = require('uuid');

// Generate a cryptographically strong temp password
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

// POST /api/users - Create user (super_admin creates manager OR employee, manager creates employee)
const createUser = async (req, res) => {
  try {
    const { name, email, role, department, phone } = req.body;
    const creator = req.user;

    // Role permission check — super_admin can create both manager and employee
    if (creator.role === 'super_admin' && !['manager', 'employee'].includes(role)) {
      return res.status(403).json({ success: false, message: 'Super Admin can only create Managers or Employees' });
    }
    if (creator.role === 'manager' && role !== 'employee') {
      return res.status(403).json({ success: false, message: 'Manager can only create Employees' });
    }

    // ── Subscription tier limit enforcement ──────────────────────────────────
    if (creator.organizationId) {
      const org = await Organization.findById(creator.organizationId);
      if (org) {
        if (role === 'manager') {
          const managerCount = await User.countDocuments({ organizationId: org._id, role: 'manager', isActive: true });
          if (managerCount >= org.limits.managers) {
            return res.status(403).json({
              success: false,
              message: `Your ${org.subscriptionTier} plan allows a maximum of ${org.limits.managers} manager${org.limits.managers > 1 ? 's' : ''}. Upgrade to add more.`,
              upgradeRequired: true,
            });
          }
        }
        if (role === 'employee') {
          const empCount = await User.countDocuments({ organizationId: org._id, role: 'employee', isActive: true });
          if (empCount >= org.limits.totalEmployees) {
            return res.status(403).json({
              success: false,
              message: `Your ${org.subscriptionTier} plan allows a maximum of ${org.limits.totalEmployees} employees. Upgrade to add more.`,
              upgradeRequired: true,
            });
          }
          // Per-manager limit
          if (creator.role === 'manager') {
            const underManager = await User.countDocuments({ managerId: creator._id, role: 'employee', isActive: true });
            if (underManager >= org.limits.employeesPerManager) {
              return res.status(403).json({
                success: false,
                message: `You have reached the limit of ${org.limits.employeesPerManager} employees on your plan. Upgrade to add more.`,
                upgradeRequired: true,
              });
            }
          }
        }
      }
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ success: false, message: 'Email already in use' });
    }

    const tempPassword = generateTempPassword();

    const newUser = await User.create({
      name,
      email: email.toLowerCase(),
      password: tempPassword,
      role,
      department: department || '',
      phone: phone || '',
      createdBy: creator._id,
      managerId: creator.role === 'manager' ? creator._id : null,
      organizationId: creator.organizationId || null,
      subscriptionTier: creator.subscriptionTier || 'free',
      isFirstLogin: true,
    });

    // Send welcome email
    await sendWelcomeEmail(newUser, tempPassword);

    // Notify new user
    await Notification.create({
      recipient: newUser._id,
      type: 'account_created',
      title: 'Welcome to TaskBridge',
      message: `Your account has been created by ${creator.name}. Check your email for login credentials.`,
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
      message: `${role.charAt(0).toUpperCase() + role.slice(1)} created successfully. Credentials sent to ${email}`,
      user: newUser,
      // Always return temp password so admin can share it manually
      tempPassword,
    });
  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).json({ success: false, message: 'Failed to create user' });
  }
};

// GET /api/users - Get users (filtered by role of requester)
const getUsers = async (req, res) => {
  try {
    const requester = req.user;
    let query = {};

    if (requester.role === 'super_admin') {
      query = { role: 'manager' };
    } else if (requester.role === 'manager') {
      query = { role: 'employee', managerId: requester._id };
    } else {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const users = await User.find(query).select('-password -refreshTokens').sort({ createdAt: -1 });
    res.json({ success: true, users });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch users' });
  }
};

// GET /api/users/:id - Get single user
const getUserById = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password -refreshTokens');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // Access control
    const requester = req.user;
    if (
      requester.role === 'employee' && requester._id.toString() !== req.params.id
    ) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch user' });
  }
};

// PUT /api/users/:id - Update user
const updateUser = async (req, res) => {
  try {
    const { name, department, phone, isActive } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

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
      details: { updatedFields: ['name','department','phone','isActive'].filter(f => req.body[f] !== undefined) },
      ipAddress: req.ip,
    });

    res.json({ success: true, message: 'User updated successfully', user });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update user' });
  }
};

// GET /api/users/stats - Dashboard stats
const getDashboardStats = async (req, res) => {
  try {
    const requester = req.user;
    const Task = require('../models/Task');

    if (requester.role === 'super_admin') {
      const totalManagers = await User.countDocuments({ role: 'manager' });
      const totalEmployees = await User.countDocuments({ role: 'employee' });
      const totalTasks = await Task.countDocuments();
      const recentManagers = await User.find({ role: 'manager' })
        .sort({ createdAt: -1 })
        .limit(5)
        .select('name email department createdAt isActive');

      return res.json({
        success: true,
        stats: { totalManagers, totalEmployees, totalTasks },
        recentManagers,
      });
    }

    if (requester.role === 'manager') {
      const myEmployees = await User.find({ managerId: requester._id }).select('_id');
      const employeeIds = myEmployees.map((e) => e._id);
      const totalEmployees = myEmployees.length;
      const totalTasks = await Task.countDocuments({ assignedBy: requester._id });
      const completedTasks = await Task.countDocuments({ assignedBy: requester._id, status: 'completed' });
      const pendingTasks = await Task.countDocuments({ assignedBy: requester._id, status: { $in: ['not_started', 'in_progress'] } });
      const overdueTasks = await Task.countDocuments({ assignedBy: requester._id, deadline: { $lt: new Date() }, status: { $nin: ['completed', 'cancelled'] } });
      const underReviewTasks = await Task.countDocuments({ assignedBy: requester._id, status: 'under_review' });

      return res.json({
        success: true,
        stats: { totalEmployees, totalTasks, completedTasks, pendingTasks, overdueTasks, underReviewTasks },
      });
    }

    if (requester.role === 'employee') {
      const totalTasks = await Task.countDocuments({ assignedTo: requester._id });
      const completedTasks = await Task.countDocuments({ assignedTo: requester._id, status: 'completed' });
      const inProgressTasks = await Task.countDocuments({ assignedTo: requester._id, status: 'in_progress' });
      const overdueTasks = await Task.countDocuments({ assignedTo: requester._id, deadline: { $lt: new Date() }, status: { $nin: ['completed', 'cancelled'] } });
      const notStartedTasks = await Task.countDocuments({ assignedTo: requester._id, status: 'not_started' });

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

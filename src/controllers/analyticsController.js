const User = require('../models/User');
const Task = require('../models/Task');
const Organization = require('../models/Organization');
const AuditLog = require('../models/AuditLog');
const Feedback = require('../models/Feedback');

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/analytics/org
// ─────────────────────────────────────────────────────────────────────────────
const getOrgAnalytics = async (req, res) => {
  try {
    const user  = req.user;
    const orgId = user.organizationId;
    if (!orgId) return res.status(400).json({ success: false, message: 'No organisation found' });

    const org = await Organization.findById(orgId).select('name subscriptionTier limits storage');
    if (!org) return res.status(404).json({ success: false, message: 'Organisation not found' });

    // Task model uses: assignedBy (manager), assignedTo (employee)
    // Always scope to this organisation first
    const taskFilter = user.role === 'manager'
      ? { organizationId: orgId, assignedBy: user._id }
      : { organizationId: orgId };

    const [
      tasksByStatus,
      tasksByPriority,
      overdueCount,
      completedLast30,
      totalTasks,
    ] = await Promise.all([
      Task.aggregate([
        { $match: taskFilter },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      Task.aggregate([
        { $match: taskFilter },
        { $group: { _id: '$priority', count: { $sum: 1 } } },
      ]),
      Task.countDocuments({ ...taskFilter, status: { $nin: ['completed'] }, deadline: { $lt: new Date() } }),
      Task.countDocuments({ ...taskFilter, status: 'completed', updatedAt: { $gte: new Date(Date.now() - 30 * 24 * 3600000) } }),
      Task.countDocuments(taskFilter),
    ]);

    // Monthly trend (last 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
    sixMonthsAgo.setDate(1);
    sixMonthsAgo.setHours(0, 0, 0, 0);

    const monthlyTrend = await Task.aggregate([
      { $match: { ...taskFilter, status: 'completed', updatedAt: { $gte: sixMonthsAgo } } },
      { $group: { _id: { year: { $year: '$updatedAt' }, month: { $month: '$updatedAt' } }, count: { $sum: 1 } } },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]);

    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      const y = d.getFullYear(), m = d.getMonth() + 1;
      const found = monthlyTrend.find(t => t._id.year === y && t._id.month === m);
      months.push({ label: d.toLocaleString('default', { month: 'short', year: '2-digit' }), count: found ? found.count : 0 });
    }

    // Employee performance — Task model uses 'assignedTo' not 'assigneeId'
    const employeePerformanceRaw = await Task.aggregate([
      { $match: { ...taskFilter, assignedTo: { $exists: true } } },
      {
        $group: {
          _id: '$assignedTo',
          total:     { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          overdue:   { $sum: { $cond: [{ $and: [{ $ne: ['$status', 'completed'] }, { $lt: ['$deadline', new Date()] }] }, 1, 0] } },
        },
      },
      { $sort: { completed: -1 } },
      { $limit: 10 },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'employee' } },
      { $unwind: { path: '$employee', preserveNullAndEmptyArrays: false } },
      {
        $project: {
          name:      '$employee.name',
          total:     1,
          completed: 1,
          overdue:   1,
        },
      },
    ]);
    const employeePerformance = employeePerformanceRaw.map((emp) => ({
      ...emp,
      rate: emp.total > 0 ? Math.round((emp.completed / emp.total) * 100) : 0,
    }));

    // Manager performance (super_admin only) — Task model uses 'assignedBy' not 'managerId'
    let managerPerformance = [];
    if (user.role === 'super_admin') {
      const managerPerformanceRaw = await Task.aggregate([
        { $match: { organizationId: orgId, assignedBy: { $exists: true } } },
        {
          $group: {
            _id: '$assignedBy',
            totalAssigned: { $sum: 1 },
            completed:     { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            overdue:       { $sum: { $cond: [{ $and: [{ $ne: ['$status', 'completed'] }, { $lt: ['$deadline', new Date()] }] }, 1, 0] } },
          },
        },
        { $sort: { completed: -1 } },
        { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'manager' } },
        { $unwind: { path: '$manager', preserveNullAndEmptyArrays: false } },
        {
          $project: {
            name:          '$manager.name',
            totalAssigned: 1,
            completed:     1,
            overdue:       1,
          },
        },
      ]);
      managerPerformance = managerPerformanceRaw.map((mgr) => ({
        ...mgr,
        rate: mgr.totalAssigned > 0 ? Math.round((mgr.completed / mgr.totalAssigned) * 100) : 0,
      }));
    }

    // Feedback — Feedback model has no organizationId, so filter via tasks in this org
    // Get task IDs that belong to this org, then match feedback on those tasks
    const orgTaskIds = await Task.distinct('_id', { organizationId: orgId });
    const feedbackStats = await Feedback.aggregate([
      { $match: { task: { $in: orgTaskIds } } },
      { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
    ]);

    // User counts — scoped to org
    const [totalManagers, totalEmployees, activeUsers] = await Promise.all([
      User.countDocuments({ organizationId: orgId, role: 'manager', isActive: true }),
      User.countDocuments({ organizationId: orgId, role: 'employee', isActive: true }),
      User.countDocuments({ organizationId: orgId, isActive: true }),
    ]);

    // Storage
    const storageUsedBytes  = org.storage?.usedBytes || 0;
    const storageLimitBytes = org.limits?.storageLimitBytes || 1;
    const storageUsedPct    = Math.min(100, Math.round((storageUsedBytes / storageLimitBytes) * 100));

    const fmtBytes = (b) => {
      if (!b) return '0 B';
      if (b < 1024**3) return `${(b/1024**2).toFixed(0)} MB`;
      return `${(b/1024**3).toFixed(2)} GB`;
    };

    res.json({
      success: true,
      analytics: {
        organization: { name: org.name, tier: org.subscriptionTier },
        overview: {
          totalTasks,
          overdueCount,
          completedLast30,
          completionRate: totalTasks > 0 ? Math.round((completedLast30 / totalTasks) * 100) : 0,
          totalManagers,
          totalEmployees,
          activeUsers,
          avgRating:    feedbackStats[0] ? Math.round(feedbackStats[0].avg * 10) / 10 : null,
          totalRatings: feedbackStats[0]?.count || 0,
        },
        tasksByStatus:       Object.fromEntries(tasksByStatus.map(t => [t._id, t.count])),
        tasksByPriority:     Object.fromEntries(tasksByPriority.map(t => [t._id || 'none', t.count])),
        monthlyTrend:        months,
        employeePerformance,
        managerPerformance,
        storage: {
          usedFormatted:  fmtBytes(storageUsedBytes),
          limitFormatted: fmtBytes(storageLimitBytes),
          usedPct:        storageUsedPct,
        },
      },
    });
  } catch (err) {
    console.error('getOrgAnalytics:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch analytics' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/analytics/platform  (owner only — protected by PLATFORM_ADMIN_KEY)
// ─────────────────────────────────────────────────────────────────────────────
const getPlatformAnalytics = async (req, res) => {
  try {
    const key = req.headers['x-platform-key'];
    if (!process.env.PLATFORM_ADMIN_KEY || key !== process.env.PLATFORM_ADMIN_KEY) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600000);
    const sevenDaysAgo  = new Date(Date.now() - 7  * 24 * 3600000);

    const [totalOrgs, activeOrgs, newOrgsLast30, newOrgsLast7, orgsByTier, totalUsers, newUsersLast30, totalTasks, completedTasks] = await Promise.all([
      Organization.countDocuments(),
      Organization.countDocuments({ isActive: true }),
      Organization.countDocuments({ createdAt: { $gte: thirtyDaysAgo } }),
      Organization.countDocuments({ createdAt: { $gte: sevenDaysAgo } }),
      Organization.aggregate([{ $group: { _id: '$subscriptionTier', count: { $sum: 1 } } }]),
      User.countDocuments(),
      User.countDocuments({ createdAt: { $gte: thirtyDaysAgo } }),
      Task.countDocuments(),
      Task.countDocuments({ status: 'completed' }),
    ]);

    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
    sixMonthsAgo.setDate(1);

    const orgGrowth = await Organization.aggregate([
      { $match: { createdAt: { $gte: sixMonthsAgo } } },
      { $group: { _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } }, count: { $sum: 1 } } },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]);

    const growthMonths = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      const y = d.getFullYear(), m = d.getMonth() + 1;
      const found = orgGrowth.find(t => t._id.year === y && t._id.month === m);
      growthMonths.push({ label: d.toLocaleString('default', { month: 'short', year: '2-digit' }), count: found?.count || 0 });
    }

    const tierRevenue = { free: 0, pro: 1249, enterprise: 6499 };
    const tierCounts  = Object.fromEntries(orgsByTier.map(t => [t._id, t.count]));
    const mrr = Object.entries(tierRevenue).reduce((sum, [tier, price]) => sum + (tierCounts[tier] || 0) * price, 0);

    res.json({
      success: true,
      platform: {
        orgs:    { total: totalOrgs, active: activeOrgs, newLast30: newOrgsLast30, newLast7: newOrgsLast7 },
        users:   { total: totalUsers, newLast30: newUsersLast30 },
        tasks:   { total: totalTasks, completed: completedTasks, rate: totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0 },
        revenue: { mrr, byTier: tierCounts },
        growth:  growthMonths,
      },
    });
  } catch (err) {
    console.error('getPlatformAnalytics:', err);
    res.status(500).json({ success: false, message: 'Failed' });
  }
};

module.exports = { getOrgAnalytics, getPlatformAnalytics };

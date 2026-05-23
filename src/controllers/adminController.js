const User = require('../models/User');
const Task = require('../models/Task');
const Feedback = require('../models/Feedback');
const Notification = require('../models/Notification');

// GET /api/admin/overview - scoped to org
const getSystemOverview = async (req, res) => {
  try {
    const orgId = req.user.organizationId;
    const orgFilter = { organizationId: orgId };

    const [
      totalManagers, totalEmployees, activeManagers, activeEmployees,
      totalTasks, completedTasks, inProgressTasks, overdueTasks,
      notStartedTasks, underReviewTasks,
    ] = await Promise.all([
      User.countDocuments({ ...orgFilter, role: 'manager' }),
      User.countDocuments({ ...orgFilter, role: 'employee' }),
      User.countDocuments({ ...orgFilter, role: 'manager', isActive: true }),
      User.countDocuments({ ...orgFilter, role: 'employee', isActive: true }),
      Task.countDocuments(orgFilter),
      Task.countDocuments({ ...orgFilter, status: 'completed' }),
      Task.countDocuments({ ...orgFilter, status: 'in_progress' }),
      Task.countDocuments({ ...orgFilter, status: 'overdue' }),
      Task.countDocuments({ ...orgFilter, status: 'not_started' }),
      Task.countDocuments({ ...orgFilter, status: 'under_review' }),
    ]);

    const recentTasks = await Task.find(orgFilter)
      .populate('assignedTo', 'name')
      .populate('assignedBy', 'name')
      .sort({ updatedAt: -1 })
      .limit(10)
      .select('title status priority deadline assignedTo assignedBy updatedAt');

    res.json({
      success: true,
      stats: {
        totalManagers, totalEmployees, activeManagers, activeEmployees,
        totalTasks, completedTasks, inProgressTasks, overdueTasks,
        notStartedTasks, underReviewTasks,
        completionRate: totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0,
      },
      recentTasks,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch system overview' });
  }
};

// GET /api/admin/managers - scoped to org
const getAllManagers = async (req, res) => {
  try {
    const orgId = req.user.organizationId;
    const managers = await User.find({ organizationId: orgId, role: 'manager' })
      .select('name email department phone isActive createdAt lastLogin')
      .sort({ createdAt: -1 });

    const managersWithStats = await Promise.all(managers.map(async (mgr) => {
      const [teamSize, totalTasks, completedTasks, overdueTasks] = await Promise.all([
        User.countDocuments({ managerId: mgr._id, organizationId: orgId, role: 'employee' }),
        Task.countDocuments({ assignedBy: mgr._id, organizationId: orgId }),
        Task.countDocuments({ assignedBy: mgr._id, organizationId: orgId, status: 'completed' }),
        Task.countDocuments({ assignedBy: mgr._id, organizationId: orgId, status: 'overdue' }),
      ]);
      return {
        ...mgr.toJSON(),
        stats: { teamSize, totalTasks, completedTasks, overdueTasks },
      };
    }));

    res.json({ success: true, managers: managersWithStats });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch managers' });
  }
};

// GET /api/admin/managers/:id - scoped to org
const getManagerProfile = async (req, res) => {
  try {
    const orgId = req.user.organizationId;
    const mgr = await User.findOne({ _id: req.params.id, role: 'manager', organizationId: orgId })
      .select('-password -refreshTokens');
    if (!mgr) return res.status(404).json({ success: false, message: 'Manager not found' });

    const employees = await User.find({ managerId: mgr._id, organizationId: orgId, role: 'employee' })
      .select('name email department isActive createdAt');

    const [totalTasks, completedTasks, overdueTasks, underReview] = await Promise.all([
      Task.countDocuments({ assignedBy: mgr._id, organizationId: orgId }),
      Task.countDocuments({ assignedBy: mgr._id, organizationId: orgId, status: 'completed' }),
      Task.countDocuments({ assignedBy: mgr._id, organizationId: orgId, status: 'overdue' }),
      Task.countDocuments({ assignedBy: mgr._id, organizationId: orgId, status: 'under_review' }),
    ]);

    res.json({
      success: true,
      manager: mgr,
      employees,
      stats: { totalTasks, completedTasks, overdueTasks, underReview },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch manager profile' });
  }
};

// GET /api/admin/employees - scoped to org
const getAllEmployees = async (req, res) => {
  try {
    const orgId = req.user.organizationId;
    const employees = await User.find({ organizationId: orgId, role: 'employee' })
      .select('name email department phone isActive createdAt managerId')
      .populate('managerId', 'name')
      .sort({ createdAt: -1 });

    const employeesWithStats = await Promise.all(employees.map(async (emp) => {
      const [totalTasks, completedTasks, overdueTasks] = await Promise.all([
        Task.countDocuments({ assignedTo: emp._id, organizationId: orgId }),
        Task.countDocuments({ assignedTo: emp._id, organizationId: orgId, status: 'completed' }),
        Task.countDocuments({ assignedTo: emp._id, organizationId: orgId, status: 'overdue' }),
      ]);
      return { ...emp.toJSON(), stats: { totalTasks, completedTasks, overdueTasks } };
    }));

    res.json({ success: true, employees: employeesWithStats });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch employees' });
  }
};

// GET /api/admin/employees/:id - scoped to org
const getEmployeeProfile = async (req, res) => {
  try {
    const orgId = req.user.organizationId;
    const emp = await User.findOne({ _id: req.params.id, role: 'employee', organizationId: orgId })
      .select('-password -refreshTokens')
      .populate('managerId', 'name email');
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

    const tasks = await Task.find({ assignedTo: emp._id, organizationId: orgId })
      .populate('assignedBy', 'name')
      .sort({ createdAt: -1 })
      .limit(20)
      .select('title status priority deadline assignedBy createdAt');

    const [totalTasks, completedTasks, overdueTasks, inProgress] = await Promise.all([
      Task.countDocuments({ assignedTo: emp._id, organizationId: orgId }),
      Task.countDocuments({ assignedTo: emp._id, organizationId: orgId, status: 'completed' }),
      Task.countDocuments({ assignedTo: emp._id, organizationId: orgId, status: 'overdue' }),
      Task.countDocuments({ assignedTo: emp._id, organizationId: orgId, status: 'in_progress' }),
    ]);

    const feedbacks = await Feedback.find({ givenTo: emp._id })
      .populate('givenBy', 'name')
      .sort({ createdAt: -1 })
      .limit(10);

    res.json({
      success: true,
      employee: emp,
      tasks,
      feedbacks,
      stats: { totalTasks, completedTasks, overdueTasks, inProgress },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch employee profile' });
  }
};

// POST /api/admin/notify-all - notify all org users
const notifyAll = async (req, res) => {
  try {
    const { title, message } = req.body;
    if (!title || !message) return res.status(400).json({ success: false, message: 'Title and message required' });

    const orgId = req.user.organizationId;
    const users = await User.find({ organizationId: orgId, isActive: true }).select('_id');

    await Notification.insertMany(
      users.map((u) => ({
        recipient: u._id,
        type: 'system',
        title,
        message,
      }))
    );

    res.json({ success: true, message: `Notification sent to ${users.length} users` });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to send notifications' });
  }
};

module.exports = { getSystemOverview, getAllManagers, getManagerProfile, getAllEmployees, getEmployeeProfile, notifyAll };

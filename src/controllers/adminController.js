const User = require('../models/User');
const Task = require('../models/Task');
const Feedback = require('../models/Feedback');
const Notification = require('../models/Notification');

// GET /api/admin/overview - System-wide stats
const getSystemOverview = async (req, res) => {
  try {
    const [
      totalManagers, totalEmployees, activeManagers, activeEmployees,
      totalTasks, completedTasks, inProgressTasks, overdueTasks,
      notStartedTasks, underReviewTasks,
    ] = await Promise.all([
      User.countDocuments({ role: 'manager' }),
      User.countDocuments({ role: 'employee' }),
      User.countDocuments({ role: 'manager', isActive: true }),
      User.countDocuments({ role: 'employee', isActive: true }),
      Task.countDocuments(),
      Task.countDocuments({ status: 'completed' }),
      Task.countDocuments({ status: 'in_progress' }),
      Task.countDocuments({ status: 'overdue' }),
      Task.countDocuments({ status: 'not_started' }),
      Task.countDocuments({ status: 'under_review' }),
    ]);

    // Recent activity (last 10 tasks)
    const recentTasks = await Task.find()
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

// GET /api/admin/managers - All managers with their stats
const getAllManagers = async (req, res) => {
  try {
    const managers = await User.find({ role: 'manager' })
      .select('name email department phone isActive createdAt lastLogin')
      .sort({ createdAt: -1 });

    const managersWithStats = await Promise.all(managers.map(async (mgr) => {
      const [teamSize, totalTasks, completedTasks, overdueTasks] = await Promise.all([
        User.countDocuments({ managerId: mgr._id, role: 'employee' }),
        Task.countDocuments({ assignedBy: mgr._id }),
        Task.countDocuments({ assignedBy: mgr._id, status: 'completed' }),
        Task.countDocuments({ assignedBy: mgr._id, status: 'overdue' }),
      ]);
      return {
        ...mgr.toObject(),
        stats: { teamSize, totalTasks, completedTasks, overdueTasks,
          completionRate: totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0,
        },
      };
    }));

    res.json({ success: true, managers: managersWithStats });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch managers' });
  }
};

// GET /api/admin/managers/:id/profile - Deep profile of a manager
const getManagerProfile = async (req, res) => {
  try {
    const mgr = await User.findOne({ _id: req.params.id, role: 'manager' })
      .select('-password -refreshTokens');
    if (!mgr) return res.status(404).json({ success: false, message: 'Manager not found' });

    // Their team
    const employees = await User.find({ managerId: mgr._id, role: 'employee' })
      .select('name email department isActive createdAt');

    // Task breakdown
    const [totalTasks, completedTasks, inProgressTasks, overdueTasks, underReviewTasks, notStartedTasks] =
      await Promise.all([
        Task.countDocuments({ assignedBy: mgr._id }),
        Task.countDocuments({ assignedBy: mgr._id, status: 'completed' }),
        Task.countDocuments({ assignedBy: mgr._id, status: 'in_progress' }),
        Task.countDocuments({ assignedBy: mgr._id, status: 'overdue' }),
        Task.countDocuments({ assignedBy: mgr._id, status: 'under_review' }),
        Task.countDocuments({ assignedBy: mgr._id, status: 'not_started' }),
      ]);

    // Recent tasks
    const recentTasks = await Task.find({ assignedBy: mgr._id })
      .populate('assignedTo', 'name')
      .sort({ updatedAt: -1 })
      .limit(10)
      .select('title status priority deadline assignedTo updatedAt');

    res.json({
      success: true,
      manager: mgr,
      employees,
      taskStats: { totalTasks, completedTasks, inProgressTasks, overdueTasks, underReviewTasks, notStartedTasks,
        completionRate: totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0,
      },
      recentTasks,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch manager profile' });
  }
};

// GET /api/admin/employees - All employees across all managers
const getAllEmployees = async (req, res) => {
  try {
    const employees = await User.find({ role: 'employee' })
      .populate('managerId', 'name email')
      .select('name email department phone isActive createdAt lastLogin managerId')
      .sort({ createdAt: -1 });

    const employeesWithStats = await Promise.all(employees.map(async (emp) => {
      const [totalTasks, completedTasks, overdueTasks, inProgressTasks] = await Promise.all([
        Task.countDocuments({ assignedTo: emp._id }),
        Task.countDocuments({ assignedTo: emp._id, status: 'completed' }),
        Task.countDocuments({ assignedTo: emp._id, status: 'overdue' }),
        Task.countDocuments({ assignedTo: emp._id, status: 'in_progress' }),
      ]);

      // Average feedback rating received
      const feedbacks = await Feedback.find({ givenTo: emp._id, type: 'manager_to_employee' });
      const avgRating = feedbacks.length > 0
        ? (feedbacks.reduce((s, f) => s + f.rating, 0) / feedbacks.length).toFixed(1)
        : null;

      return {
        ...emp.toObject(),
        stats: { totalTasks, completedTasks, overdueTasks, inProgressTasks,
          completionRate: totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0,
          avgRating, totalFeedbacks: feedbacks.length,
        },
      };
    }));

    res.json({ success: true, employees: employeesWithStats });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch employees' });
  }
};

// GET /api/admin/employees/:id/profile - Deep profile of an employee
const getEmployeeProfile = async (req, res) => {
  try {
    const emp = await User.findOne({ _id: req.params.id, role: 'employee' })
      .populate('managerId', 'name email department')
      .select('-password -refreshTokens');
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

    // Task breakdown
    const [totalTasks, completedTasks, inProgressTasks, overdueTasks, underReviewTasks, notStartedTasks] =
      await Promise.all([
        Task.countDocuments({ assignedTo: emp._id }),
        Task.countDocuments({ assignedTo: emp._id, status: 'completed' }),
        Task.countDocuments({ assignedTo: emp._id, status: 'in_progress' }),
        Task.countDocuments({ assignedTo: emp._id, status: 'overdue' }),
        Task.countDocuments({ assignedTo: emp._id, status: 'under_review' }),
        Task.countDocuments({ assignedTo: emp._id, status: 'not_started' }),
      ]);

    // All tasks
    const tasks = await Task.find({ assignedTo: emp._id })
      .populate('assignedBy', 'name')
      .sort({ updatedAt: -1 })
      .limit(20)
      .select('title status priority deadline assignedBy updatedAt completedAt');

    // Feedback received
    const feedbacks = await Feedback.find({ givenTo: emp._id, type: 'manager_to_employee' })
      .populate('givenBy', 'name')
      .populate('task', 'title')
      .sort({ createdAt: -1 });

    const avgRating = feedbacks.length > 0
      ? (feedbacks.reduce((s, f) => s + f.rating, 0) / feedbacks.length).toFixed(1)
      : null;

    res.json({
      success: true,
      employee: emp,
      taskStats: { totalTasks, completedTasks, inProgressTasks, overdueTasks, underReviewTasks, notStartedTasks,
        completionRate: totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0,
      },
      tasks,
      feedbacks,
      avgRating,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch employee profile' });
  }
};

// POST /api/admin/feedback - Super Admin gives feedback to any employee
const adminGiveFeedback = async (req, res) => {
  try {
    const { employeeId, rating, comment } = req.body;
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, message: 'Rating must be 1–5' });
    }

    const employee = await User.findOne({ _id: employeeId, role: 'employee' });
    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found' });

    // Use a dummy taskId reference or make it optional
    const feedback = await Feedback.create({
      task: null,
      givenBy: req.user._id,
      givenTo: employeeId,
      rating,
      comment,
      type: 'manager_to_employee',
    });

    await Notification.create({
      recipient: employeeId,
      type: 'feedback_received',
      title: 'You received feedback from Super Admin!',
      message: `Super Admin rated your overall performance ${rating}/5${comment ? ': ' + comment : ''}`,
    });

    res.status(201).json({ success: true, message: 'Feedback submitted!', feedback });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to submit feedback' });
  }
};

module.exports = {
  getSystemOverview,
  getAllManagers,
  getManagerProfile,
  getAllEmployees,
  getEmployeeProfile,
  adminGiveFeedback,
};

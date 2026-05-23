const Task = require('../models/Task');
const User = require('../models/User');
const Notification = require('../models/Notification');
const AuditLog = require('../models/AuditLog');

// ─── CREATE TASK ────────────────────────────────────────────────────────────
const createTask = async (req, res) => {
  try {
    const { title, description, priority, deadline, assignedTo } = req.body;

    const employee = await User.findOne({
      _id: assignedTo,
      managerId: req.user._id,
      role: 'employee',
      organizationId: req.user.organizationId,
    });
    if (!employee) {
      return res.status(400).json({ success: false, message: 'Employee not found or not under your management' });
    }

    const task = await Task.create({
      title,
      description,
      priority: priority || 'medium',
      deadline: new Date(deadline),
      assignedTo,
      assignedBy: req.user._id,
      organizationId: req.user.organizationId,
    });

    await Notification.create({
      recipient: assignedTo,
      type: 'task_assigned',
      title: 'New Task Assigned',
      message: `You have been assigned a new task: "${title}" by ${req.user.name}`,
      relatedTask: task._id,
    });

    await AuditLog.create({
      performedBy: req.user._id,
      action: 'TASK_CREATED',
      targetModel: 'Task',
      targetId: task._id,
      details: { title, assignedTo, priority, deadline },
      ipAddress: req.ip,
    });

    const populatedTask = await Task.findById(task._id)
      .populate('assignedTo', 'name email')
      .populate('assignedBy', 'name email');

    res.status(201).json({ success: true, message: 'Task created successfully', task: populatedTask });
  } catch (error) {
    console.error('Create task error:', error);
    res.status(500).json({ success: false, message: 'Failed to create task' });
  }
};

// ─── GET ALL TASKS ──────────────────────────────────────────────────────────
const getTasks = async (req, res) => {
  try {
    const requester = req.user;
    const { status, priority, page = 1, limit = 20 } = req.query;

    // Always filter by organization first
    let query = { organizationId: requester.organizationId };

    if (requester.role === 'manager') query.assignedBy = requester._id;
    else if (requester.role === 'employee') query.assignedTo = requester._id;

    if (status) query.status = status;
    if (priority) query.priority = priority;

    // Auto-mark overdue
    await Task.updateMany(
      { ...query, deadline: { $lt: new Date() }, status: { $in: ['not_started', 'in_progress'] } },
      { status: 'overdue' }
    );

    const tasks = await Task.find(query)
      .populate('assignedTo', 'name email')
      .populate('assignedBy', 'name email')
      .sort({ deadline: 1, priority: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await Task.countDocuments(query);

    res.json({ success: true, tasks, total, page: parseInt(page), totalPages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch tasks' });
  }
};

// ─── GET SINGLE TASK ────────────────────────────────────────────────────────
const getTaskById = async (req, res) => {
  try {
    const task = await Task.findOne({
      _id: req.params.id,
      organizationId: req.user.organizationId,
    })
      .populate('assignedTo', 'name email')
      .populate('assignedBy', 'name email');

    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    const requester = req.user;
    if (
      requester.role === 'employee' &&
      task.assignedTo._id.toString() !== requester._id.toString()
    ) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    res.json({ success: true, task });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch task' });
  }
};

// ─── UPDATE TASK STATUS (employee) ─────────────────────────────────────────
const updateTaskStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const task = await Task.findOne({
      _id: req.params.id,
      organizationId: req.user.organizationId,
    });
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    const validTransitions = {
      not_started: ['in_progress'],
      in_progress: ['under_review'],
      under_review: [],
      completed: [],
      overdue: ['in_progress'],
    };

    if (!validTransitions[task.status]?.includes(status)) {
      return res.status(400).json({ success: false, message: `Cannot transition from ${task.status} to ${status}` });
    }

    const oldStatus = task.status;
    task.status = status;
    if (status === 'in_progress' && !task.acceptedAt) task.acceptedAt = new Date();
    if (status === 'under_review') task.submittedAt = new Date();
    await task.save();

    if (status === 'under_review') {
      await Notification.create({
        recipient: task.assignedBy,
        type: 'task_submitted',
        title: 'Task Submitted for Review',
        message: `${req.user.name} has submitted "${task.title}" for review`,
        relatedTask: task._id,
      });
    }

    await AuditLog.create({
      performedBy: req.user._id,
      action: 'TASK_STATUS_UPDATED',
      targetModel: 'Task',
      targetId: task._id,
      details: { from: oldStatus, to: status },
      ipAddress: req.ip,
    });

    res.json({ success: true, message: 'Task status updated', task });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update task status' });
  }
};

// ─── ACCEPT OR FLAG TASK (employee) ────────────────────────────────────────
const acceptOrFlagTask = async (req, res) => {
  try {
    const { action, flagReason } = req.body;
    const task = await Task.findOne({
      _id: req.params.id,
      assignedTo: req.user._id,
      organizationId: req.user.organizationId,
    });
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    if (action === 'accept') {
      task.status = 'in_progress';
      task.acceptedAt = new Date();
      task.isFlagged = false;
    } else if (action === 'flag') {
      task.isFlagged = true;
      task.flagReason = flagReason || '';
      await Notification.create({
        recipient: task.assignedBy,
        type: 'task_flagged',
        title: 'Task Flagged',
        message: `${req.user.name} has flagged task "${task.title}": ${flagReason}`,
        relatedTask: task._id,
      });
    }

    await task.save();
    res.json({ success: true, message: `Task ${action === 'accept' ? 'accepted' : 'flagged'} successfully`, task });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update task' });
  }
};

// ─── REVIEW TASK (manager) ──────────────────────────────────────────────────
const reviewTask = async (req, res) => {
  try {
    const { action, revisionNote } = req.body;
    const task = await Task.findOne({
      _id: req.params.id,
      assignedBy: req.user._id,
      organizationId: req.user.organizationId,
      status: 'under_review',
    });
    if (!task) return res.status(404).json({ success: false, message: 'Task not found or not under review' });

    if (action === 'approve') {
      task.status = 'completed';
      task.completedAt = new Date();
    } else if (action === 'revision') {
      task.status = 'in_progress';
      task.revisionNote = revisionNote || '';
    }

    await task.save();

    await Notification.create({
      recipient: task.assignedTo,
      type: action === 'approve' ? 'task_approved' : 'revision_requested',
      title: action === 'approve' ? 'Task Approved!' : 'Revision Requested',
      message: action === 'approve'
        ? `Your task "${task.title}" has been approved by ${req.user.name}`
        : `${req.user.name} has requested revision on "${task.title}": ${revisionNote}`,
      relatedTask: task._id,
    });

    res.json({ success: true, message: `Task ${action === 'approve' ? 'approved' : 'sent back for revision'}`, task });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to review task' });
  }
};

// ─── REQUEST DEADLINE EXTENSION (employee) ──────────────────────────────────
const requestExtension = async (req, res) => {
  try {
    const { extensionReason, extensionDate } = req.body;
    if (!extensionReason || !extensionDate) {
      return res.status(400).json({ success: false, message: 'Reason and new date are required' });
    }

    const task = await Task.findOne({
      _id: req.params.id,
      assignedTo: req.user._id,
      organizationId: req.user.organizationId,
    });
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    if (task.extensionRequested && task.extensionStatus === 'pending') {
      return res.status(400).json({ success: false, message: 'Extension already requested and pending' });
    }

    task.extensionRequested = true;
    task.extensionReason = extensionReason;
    task.extensionDate = new Date(extensionDate);
    task.extensionStatus = 'pending';
    await task.save();

    await Notification.create({
      recipient: task.assignedBy,
      type: 'status_updated',
      title: 'Deadline Extension Requested',
      message: `${req.user.name} requested a deadline extension for "${task.title}" to ${new Date(extensionDate).toDateString()}. Reason: ${extensionReason}`,
      relatedTask: task._id,
    });

    res.json({ success: true, message: 'Extension request submitted', task });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to request extension' });
  }
};

// ─── REVIEW EXTENSION (manager) ─────────────────────────────────────────────
const reviewExtension = async (req, res) => {
  try {
    const { action } = req.body;
    const task = await Task.findOne({
      _id: req.params.id,
      assignedBy: req.user._id,
      organizationId: req.user.organizationId,
      extensionStatus: 'pending',
    });
    if (!task) return res.status(404).json({ success: false, message: 'Task not found or no pending extension' });

    if (action === 'approve') {
      task.deadline = task.extensionDate;
      task.extensionStatus = 'approved';
      if (task.status === 'overdue') task.status = 'in_progress';
    } else {
      task.extensionStatus = 'rejected';
    }

    await task.save();

    await Notification.create({
      recipient: task.assignedTo,
      type: action === 'approve' ? 'extension_approved' : 'extension_rejected',
      title: action === 'approve' ? 'Extension Approved!' : 'Extension Rejected',
      message: action === 'approve'
        ? `Your deadline extension for "${task.title}" was approved. New deadline: ${task.deadline.toDateString()}`
        : `Your deadline extension request for "${task.title}" was rejected by ${req.user.name}`,
      relatedTask: task._id,
    });

    res.json({ success: true, message: `Extension ${action}d`, task });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to review extension' });
  }
};

// ─── EDIT TASK (manager, before accepted) ───────────────────────────────────
const editTask = async (req, res) => {
  try {
    const { title, description, priority, deadline } = req.body;
    const task = await Task.findOne({
      _id: req.params.id,
      assignedBy: req.user._id,
      organizationId: req.user.organizationId,
    });
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    if (task.status !== 'not_started') {
      return res.status(400).json({ success: false, message: 'Task can only be edited before it is accepted' });
    }

    if (title) task.title = title;
    if (description) task.description = description;
    if (priority) task.priority = priority;
    if (deadline) task.deadline = new Date(deadline);
    await task.save();

    await Notification.create({
      recipient: task.assignedTo,
      type: 'status_updated',
      title: 'Task Updated',
      message: `${req.user.name} updated the task "${task.title}"`,
      relatedTask: task._id,
    });

    res.json({ success: true, message: 'Task updated', task });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update task' });
  }
};

// ─── CANCEL TASK (manager, before accepted) ──────────────────────────────────
const cancelTask = async (req, res) => {
  try {
    const task = await Task.findOne({
      _id: req.params.id,
      assignedBy: req.user._id,
      organizationId: req.user.organizationId,
    });
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    if (task.status !== 'not_started') {
      return res.status(400).json({ success: false, message: 'Task can only be cancelled before it is accepted' });
    }

    task.status = 'cancelled';
    await task.save();

    await Notification.create({
      recipient: task.assignedTo,
      type: 'status_updated',
      title: 'Task Cancelled',
      message: `${req.user.name} has cancelled the task "${task.title}"`,
      relatedTask: task._id,
    });

    await AuditLog.create({
      performedBy: req.user._id,
      action: 'TASK_CANCELLED',
      targetModel: 'Task',
      targetId: task._id,
      details: { title: task.title },
      ipAddress: req.ip,
    });

    res.json({ success: true, message: 'Task cancelled', task });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to cancel task' });
  }
};

// ─── GET TEAM WORKLOAD (manager) ────────────────────────────────────────────
const getWorkload = async (req, res) => {
  try {
    const employees = await User.find({
      managerId: req.user._id,
      role: 'employee',
      isActive: true,
      organizationId: req.user.organizationId,
    }).select('name email department');

    const workload = await Promise.all(employees.map(async (emp) => {
      const orgFilter = { assignedTo: emp._id, organizationId: req.user.organizationId };
      const total     = await Task.countDocuments(orgFilter);
      const active    = await Task.countDocuments({ ...orgFilter, status: { $in: ['not_started', 'in_progress'] } });
      const completed = await Task.countDocuments({ ...orgFilter, status: 'completed' });
      const overdue   = await Task.countDocuments({ ...orgFilter, status: 'overdue' });
      const inReview  = await Task.countDocuments({ ...orgFilter, status: 'under_review' });
      return { employee: emp, total, active, completed, overdue, inReview };
    }));

    res.json({ success: true, workload });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch workload' });
  }
};

// ─── UPLOAD TASK ATTACHMENT (manager) ───────────────────────────────────────
const uploadTaskFile = async (req, res) => {
  try {
    const { uploadToCloudinary } = require('../middleware/upload');
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

    const task = await Task.findOne({
      _id: req.params.id,
      assignedBy: req.user._id,
      organizationId: req.user.organizationId,
    });
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    const fileData = await uploadToCloudinary(req.file);
    task.files.push(fileData);
    await task.save();

    res.json({
      success: true,
      message: fileData.isMock
        ? 'File saved (mock mode — add Cloudinary credentials to .env for real uploads)'
        : 'File uploaded successfully!',
      file: fileData,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Upload failed: ' + error.message });
  }
};

// ─── UPLOAD DELIVERABLE (employee) ──────────────────────────────────────────
const uploadDeliverable = async (req, res) => {
  try {
    const { uploadToCloudinary } = require('../middleware/upload');
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

    const task = await Task.findOne({
      _id: req.params.id,
      assignedTo: req.user._id,
      organizationId: req.user.organizationId,
    });
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    if (!['in_progress', 'under_review'].includes(task.status)) {
      return res.status(400).json({ success: false, message: 'Can only upload deliverables on active tasks' });
    }

    const fileData = await uploadToCloudinary(req.file);
    task.deliverables.push(fileData);
    await task.save();

    await Notification.create({
      recipient: task.assignedBy,
      type: 'status_updated',
      title: 'Deliverable Uploaded',
      message: `${req.user.name} uploaded a deliverable for "${task.title}": ${fileData.name}`,
      relatedTask: task._id,
    });

    res.json({
      success: true,
      message: fileData.isMock
        ? 'Deliverable saved (mock mode — add Cloudinary credentials to .env for real uploads)'
        : 'Deliverable uploaded successfully!',
      file: fileData,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Upload failed: ' + error.message });
  }
};

// ─── EXPORTS ─────────────────────────────────────────────────────────────────
module.exports = {
  createTask,
  getTasks,
  getTaskById,
  updateTaskStatus,
  acceptOrFlagTask,
  reviewTask,
  requestExtension,
  reviewExtension,
  editTask,
  cancelTask,
  getWorkload,
  uploadTaskFile,
  uploadDeliverable,
};

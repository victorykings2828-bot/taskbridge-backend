const Feedback = require('../models/Feedback');
const Task = require('../models/Task');
const User = require('../models/User');
const Notification = require('../models/Notification');
const AuditLog = require('../models/AuditLog');

// POST /api/feedback - Give feedback
const giveFeedback = async (req, res) => {
  try {
    const { taskId, rating, comment, type } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, message: 'Rating must be between 1 and 5' });
    }

    const task = await Task.findOne({ _id: taskId, organizationId: req.user.organizationId });
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });
    if (task.status !== 'completed') {
      return res.status(400).json({ success: false, message: 'Feedback can only be given on completed tasks' });
    }

    // Manager gives feedback to employee
    if (type === 'manager_to_employee') {
      if (req.user.role !== 'manager') {
        return res.status(403).json({ success: false, message: 'Only managers can give this type of feedback' });
      }
      if (task.assignedBy.toString() !== req.user._id.toString()) {
        return res.status(403).json({ success: false, message: 'You can only give feedback on your own tasks' });
      }
      const existing = await Feedback.findOne({ task: taskId, type: 'manager_to_employee' });
      if (existing) return res.status(409).json({ success: false, message: 'Feedback already given for this task' });

      const feedback = await Feedback.create({
        task: taskId, rating, comment, type,
        givenBy: req.user._id,
        givenTo: task.assignedTo,
      });

      await Notification.create({
        recipient: task.assignedTo,
        type: 'feedback_received',
        title: 'You received feedback!',
        message: `${req.user.name} rated your work ${rating}/5 on task "${task.title}"`,
        relatedTask: taskId,
      });

      await AuditLog.create({
        performedBy: req.user._id, action: 'FEEDBACK_GIVEN',
        targetModel: 'Feedback', targetId: feedback._id,
        details: { taskId, rating, type }, ipAddress: req.ip,
      });

      return res.status(201).json({ success: true, message: 'Feedback submitted!', feedback });
    }

    // Employee gives feedback on task clarity
    if (type === 'employee_to_task') {
      if (req.user.role !== 'employee') {
        return res.status(403).json({ success: false, message: 'Only employees can give task clarity feedback' });
      }
      if (task.assignedTo.toString() !== req.user._id.toString()) {
        return res.status(403).json({ success: false, message: 'You can only give feedback on your own tasks' });
      }
      const existing = await Feedback.findOne({ task: taskId, type: 'employee_to_task', givenBy: req.user._id });
      if (existing) return res.status(409).json({ success: false, message: 'You have already given feedback for this task' });

      const feedback = await Feedback.create({
        task: taskId, rating, comment, type,
        givenBy: req.user._id,
        givenTo: task.assignedBy,
      });

      await Notification.create({
        recipient: task.assignedBy,
        type: 'feedback_received',
        title: 'Task clarity feedback received',
        message: `${req.user.name} rated task "${task.title}" clarity ${rating}/5`,
        relatedTask: taskId,
      });

      return res.status(201).json({ success: true, message: 'Feedback submitted!', feedback });
    }

    return res.status(400).json({ success: false, message: 'Invalid feedback type' });
  } catch (error) {
    console.error('Feedback error:', error);
    res.status(500).json({ success: false, message: 'Failed to submit feedback' });
  }
};

// GET /api/feedback?taskId=xxx
const getFeedback = async (req, res) => {
  try {
    const { taskId } = req.query;
    const orgId = req.user.organizationId;

    // A taskId, if given, MUST belong to this organization.
    if (taskId) {
      const t = await Task.findOne({ _id: taskId, organizationId: orgId }).select('_id');
      if (!t) return res.status(404).json({ success: false, message: 'Task not found' });
    }

    // Base scope: only feedback involving members of THIS organization.
    const orgUserIds = await User.find({ organizationId: orgId }).distinct('_id');
    const query = { $or: [{ givenTo: { $in: orgUserIds } }, { givenBy: { $in: orgUserIds } }] };

    if (taskId) {
      query.task = taskId;
    }

    // Role-narrowing within the org.
    if (req.user.role === 'manager' && !taskId) {
      const taskIds = await Task.find({ assignedBy: req.user._id, organizationId: orgId }).distinct('_id');
      query.$and = [{ $or: [{ task: { $in: taskIds } }, { givenBy: req.user._id }, { givenTo: req.user._id }] }];
    } else if (req.user.role === 'employee') {
      query.$and = [{ $or: [{ givenBy: req.user._id }, { givenTo: req.user._id }] }];
    }
    // super_admin: sees all feedback within the organization (base scope only)

    const feedbacks = await Feedback.find(query)
      .populate('givenBy', 'name email role')
      .populate('givenTo', 'name email role')
      .populate('task', 'title status')
      .sort({ createdAt: -1 });

    res.json({ success: true, feedbacks });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch feedback' });
  }
};

module.exports = { giveFeedback, getFeedback };

const Feedback = require('../models/Feedback');
const Task = require('../models/Task');
const Notification = require('../models/Notification');
const AuditLog = require('../models/AuditLog');

// POST /api/feedback - Give feedback
const giveFeedback = async (req, res) => {
  try {
    const { taskId, rating, comment, type } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, message: 'Rating must be between 1 and 5' });
    }

    const task = await Task.findById(taskId);
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
    const query = taskId ? { task: taskId } : {};

    // Scope to user's tasks
    if (req.user.role === 'manager') {
      const tasks = await Task.find({ assignedBy: req.user._id }).select('_id');
      const taskIds = tasks.map((t) => t._id);
      query.task = taskId ? taskId : { $in: taskIds };
    } else if (req.user.role === 'employee') {
      query.$or = [{ givenBy: req.user._id }, { givenTo: req.user._id }];
      if (taskId) query.task = taskId;
    }

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

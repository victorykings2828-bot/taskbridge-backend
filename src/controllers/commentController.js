const Comment = require('../models/Comment');
const Task = require('../models/Task');
const Notification = require('../models/Notification');
const AuditLog = require('../models/AuditLog');

// GET /api/tasks/:taskId/comments
const getComments = async (req, res) => {
  try {
    const { taskId } = req.params;

    // Verify task exists and user has access
    const task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    if (req.user.role === 'employee' && task.assignedTo.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const comments = await Comment.find({ task: taskId })
      .populate('author', 'name email role')
      .sort({ createdAt: 1 });

    res.json({ success: true, comments });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch comments' });
  }
};

// POST /api/tasks/:taskId/comments
const addComment = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ success: false, message: 'Comment cannot be empty' });
    }

    const task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    // Access: only manager who assigned OR employee it's assigned to
    const isAssignedEmployee = task.assignedTo.toString() === req.user._id.toString();
    const isAssigningManager = task.assignedBy.toString() === req.user._id.toString();

    if (!isAssignedEmployee && !isAssigningManager && req.user.role !== 'super_admin') {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const comment = await Comment.create({
      task: taskId,
      author: req.user._id,
      content: content.trim(),
    });

    const populatedComment = await Comment.findById(comment._id).populate('author', 'name email role');

    // Notify the other party
    const notifyUser = isAssignedEmployee ? task.assignedBy : task.assignedTo;
    await Notification.create({
      recipient: notifyUser,
      type: 'new_comment',
      title: 'New Comment on Task',
      message: `${req.user.name} commented on "${task.title}": "${content.trim().slice(0, 80)}${content.length > 80 ? '...' : ''}"`,
      relatedTask: taskId,
    });

    await AuditLog.create({
      performedBy: req.user._id,
      action: 'COMMENT_ADDED',
      targetModel: 'Comment',
      targetId: comment._id,
      details: { taskId },
      ipAddress: req.ip,
    });

    res.status(201).json({ success: true, comment: populatedComment });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to add comment' });
  }
};

// DELETE /api/tasks/:taskId/comments/:commentId
const deleteComment = async (req, res) => {
  try {
    const comment = await Comment.findById(req.params.commentId);
    if (!comment) return res.status(404).json({ success: false, message: 'Comment not found' });

    if (comment.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'You can only delete your own comments' });
    }

    await comment.deleteOne();
    res.json({ success: true, message: 'Comment deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to delete comment' });
  }
};

module.exports = { getComments, addComment, deleteComment };

const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    type: {
      type: String,
      enum: [
        'task_assigned',
        'task_flagged',
        'status_updated',
        'task_submitted',
        'task_approved',
        'revision_requested',
        'extension_approved',
        'extension_rejected',
        'new_comment',
        'feedback_received',
        'account_created',
      ],
      required: true,
    },
    title: { type: String, required: true },
    message: { type: String, required: true },
    relatedTask: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Task',
      default: null,
    },
    isRead: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Notification', notificationSchema);

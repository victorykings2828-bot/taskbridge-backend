const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema(
  {
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    action: { type: String, required: true },
    targetModel: { type: String, enum: ['User', 'Task', 'Feedback', 'Comment', 'Organization', 'Notification', 'Invite'], required: true },
    targetId: { type: mongoose.Schema.Types.ObjectId, required: true },
    details: { type: Object, default: {} },
    ipAddress: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AuditLog', auditLogSchema);

const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Task title is required'],
      trim: true,
      maxlength: [200, 'Title cannot exceed 200 characters'],
    },
    description: {
      type: String,
      required: [true, 'Task description is required'],
      maxlength: [5000, 'Description cannot exceed 5000 characters'],
    },
    priority: {
      type: String,
      enum: ['high', 'medium', 'low'],
      default: 'medium',
    },
    status: {
      type: String,
      enum: ['not_started', 'in_progress', 'under_review', 'completed', 'overdue', 'cancelled'],
      default: 'not_started',
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    deadline: {
      type: Date,
      required: [true, 'Deadline is required'],
    },
    acceptedAt: { type: Date, default: null },
    submittedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    files: [
      {
        url: String,
        publicId: String,
        name: String,
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
    deliverables: [
      {
        url: String,
        publicId: String,
        name: String,
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
    isFlagged: { type: Boolean, default: false },
    flagReason: { type: String, default: '' },
    revisionNote: { type: String, default: '' },
    extensionRequested: { type: Boolean, default: false },
    extensionReason: { type: String, default: '' },
    extensionDate: { type: Date, default: null },
    extensionStatus: {
      type: String,
      enum: ['pending', 'approved', 'rejected', null],
      default: null,
    },
  },
  { timestamps: true }
);

// Auto-mark overdue tasks
taskSchema.index({ deadline: 1, status: 1 });

module.exports = mongoose.model('Task', taskSchema);

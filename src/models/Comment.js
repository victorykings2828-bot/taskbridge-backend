const mongoose = require('mongoose');

const commentSchema = new mongoose.Schema(
  {
    task: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    content: {
      type: String,
      required: [true, 'Comment cannot be empty'],
      maxlength: [2000, 'Comment cannot exceed 2000 characters'],
    },
    isEdited: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Comment', commentSchema);

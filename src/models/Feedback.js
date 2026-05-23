const mongoose = require('mongoose');

const feedbackSchema = new mongoose.Schema(
  {
    task: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', default: null },
    givenBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    givenTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    rating: { type: Number, min: 1, max: 5, required: true },
    comment: { type: String, maxlength: 1000 },
    type: {
      type: String,
      enum: ['manager_to_employee', 'employee_to_task', 'admin_to_employee'],
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Feedback', feedbackSchema);

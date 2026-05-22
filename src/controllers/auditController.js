const AuditLog = require('../models/AuditLog');

// GET /api/audit-logs (super_admin only)
const getAuditLogs = async (req, res) => {
  try {
    const { page = 1, limit = 30, action } = req.query;
    const query = action ? { action } : {};

    const logs = await AuditLog.find(query)
      .populate('performedBy', 'name email role')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await AuditLog.countDocuments(query);

    res.json({ success: true, logs, total, page: parseInt(page), totalPages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch audit logs' });
  }
};

module.exports = { getAuditLogs };

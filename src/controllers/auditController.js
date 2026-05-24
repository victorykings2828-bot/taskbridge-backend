const AuditLog = require('../models/AuditLog');
const User = require('../models/User');

// GET /api/audit-logs (super_admin only) — scoped to the caller's organization.
const getAuditLogs = async (req, res) => {
  try {
    const { page = 1, limit = 30, action } = req.query;

    // Only show logs for actions performed by members of THIS organization.
    // (performedBy is always set, so this scopes existing + new logs correctly
    // without needing a data migration.)
    const orgUserIds = await User.find({ organizationId: req.user.organizationId }).distinct('_id');

    const query = { performedBy: { $in: orgUserIds } };
    if (action) query.action = action;

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

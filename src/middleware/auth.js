const { verifyAccessToken } = require('../utils/jwt');
const User = require('../models/User');

// Authenticate JWT
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Access token required' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = verifyAccessToken(token);

    const user = await User.findById(decoded.userId).select('-password -refreshTokens');
    if (!user) {
      return res.status(401).json({ success: false, message: 'User not found' });
    }
    if (!user.isActive) {
      return res.status(403).json({ success: false, message: 'Account is deactivated' });
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Access token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ success: false, message: 'Invalid access token' });
  }
};

// Role-based authorization
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Access denied. Required role: ${roles.join(' or ')}`,
      });
    }
    next();
  };
};

// Require password change check
const requirePasswordChanged = (req, res, next) => {
  if (req.user.isFirstLogin) {
    return res.status(403).json({
      success: false,
      message: 'Password change required',
      code: 'PASSWORD_CHANGE_REQUIRED',
    });
  }
  next();
};

module.exports = { authenticate, authorize, requirePasswordChanged };

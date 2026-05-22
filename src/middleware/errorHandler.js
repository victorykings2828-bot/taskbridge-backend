const isProd = process.env.NODE_ENV === 'production';

const errorHandler = (err, req, res, next) => {
  // Always log full error server-side
  console.error(`[${new Date().toISOString()}] ERROR ${req.method} ${req.path}:`, err);

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map((e) => e.message);
    return res.status(400).json({ success: false, message: messages.join(', ') });
  }

  // Mongoose duplicate key
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    return res.status(409).json({ success: false, message: `${field} already exists` });
  }

  // Mongoose cast error (invalid ObjectId)
  if (err.name === 'CastError') {
    return res.status(400).json({ success: false, message: 'Invalid ID format' });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({ success: false, message: 'Token expired', code: 'TOKEN_EXPIRED' });
  }

  // Multer file errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ success: false, message: 'File too large. Maximum size is 10MB.' });
  }
  if (err.message === 'File type not allowed') {
    return res.status(415).json({ success: false, message: 'File type not allowed.' });
  }

  // CORS error
  if (err.message && err.message.startsWith('CORS:')) {
    return res.status(403).json({ success: false, message: 'CORS: Request not allowed.' });
  }

  // Payload too large
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, message: 'Request body too large.' });
  }

  // Default — never expose internal details in production
  const statusCode = err.statusCode || err.status || 500;
  res.status(statusCode).json({
    success: false,
    message: isProd ? 'An unexpected error occurred' : (err.message || 'Internal server error'),
    // Stack trace only in development
    ...(isProd ? {} : { stack: err.stack }),
  });
};

module.exports = errorHandler;

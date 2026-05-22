const multer  = require('multer');
const { v2: cloudinary } = require('cloudinary');
const crypto  = require('crypto');
const path    = require('path');
const { Readable } = require('stream');

const isConfigured = !!(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY    &&
  process.env.CLOUDINARY_API_SECRET
);

if (isConfigured) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure:     true,
  });
}

// ── Allowed MIME types + extensions ─────────────────────────────────────────
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/jpg', 'image/webp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'application/zip',
  'application/x-zip-compressed',
]);

const ALLOWED_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.pdf',
  '.doc', '.docx', '.xls', '.xlsx', '.txt', '.zip',
]);

const BLOCKED_EXT = ['.exe', '.sh', '.bat', '.cmd', '.ps1', '.js', '.php', '.py', '.rb', '.pl'];

// ── Sanitize filename ────────────────────────────────────────────────────────
const sanitizeFilename = (original) => {
  const ext  = path.extname(original).toLowerCase();
  const base = path.basename(original, ext)
    .replace(/[^a-zA-Z0-9_\-]/g, '_')
    .slice(0, 50);
  return `${base}${ext}`;
};

// ── Multer — memory storage (buffer), then we stream to Cloudinary ───────────
// Multer v2 changed: use memoryStorage, no diskStorage needed for cloud uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB
    files: 1,
    fields: 10,
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();

    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error('File type not allowed'));
    }
    if (!ALLOWED_EXT.has(ext)) {
      return cb(new Error('File type not allowed'));
    }
    if (BLOCKED_EXT.some((b) => file.originalname.toLowerCase().includes(b))) {
      return cb(new Error('File type not allowed'));
    }
    cb(null, true);
  },
});

// ── Stream buffer to Cloudinary v2 ───────────────────────────────────────────
const streamToCloudinary = (buffer, options) =>
  new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(options, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
    Readable.from(buffer).pipe(uploadStream);
  });

// ── After multer processes the file, call this to upload to Cloudinary ────────
const uploadToCloudinary = async (file) => {
  const safeName  = sanitizeFilename(file.originalname);
  const uniqueId  = crypto.randomBytes(8).toString('hex');
  const publicId  = `${uniqueId}-${safeName.replace(/\.[^.]+$/, '')}`;

  if (!isConfigured) {
    // Mock mode — no Cloudinary credentials
    return {
      url:      `mock://uploads/${safeName}`,
      publicId: `mock-${uniqueId}`,
      name:     safeName,
      isMock:   true,
    };
  }

  const result = await streamToCloudinary(file.buffer, {
    folder:        'workdist/tasks',
    public_id:     publicId,
    resource_type: 'auto',
    type:          'upload',
  });

  return {
    url:      result.secure_url,
    publicId: result.public_id,
    name:     safeName,
  };
};

module.exports = { upload, uploadToCloudinary, isConfigured };

const multer = require('multer');

const MAX_SIZE_MB = 50;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE_MB * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(Object.assign(new Error('Only PDF files are allowed'), { code: 'INVALID_FILE_TYPE' }));
    }
  },
});

// Wraps multer errors into consistent JSON responses
function handleUploadError(err, _req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `File exceeds maximum size of ${MAX_SIZE_MB} MB` });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  if (err?.code === 'INVALID_FILE_TYPE') {
    return res.status(415).json({ error: err.message });
  }
  next(err);
}

module.exports = { upload, handleUploadError };

const { User } = require('../models');
const { generateToken } = require('../utils/jwt');
const { generatePassword } = require('../utils/generatePassword');
const emailService = require('../services/emailService');

// --- Validation helpers ---

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validationError(res, message) {
  return res.status(400).json({ error: message });
}

// POST /api/auth/register  (admin only)
async function register(req, res) {
  try {
    const { name, email, role = 'student', year_started, photo_url } = req.body;

    if (!name || !name.trim()) return validationError(res, 'Name is required');
    if (!email) return validationError(res, 'Email is required');
    if (!isValidEmail(email)) return validationError(res, 'Invalid email address');
    if (!['admin', 'student'].includes(role)) return validationError(res, 'Role must be admin or student');

    const existing = await User.findOne({ where: { email: email.toLowerCase() } });
    if (existing) return validationError(res, 'Email already registered');

    const tempPassword = generatePassword(10);

    const user = await User.create({
      name: name.trim(),
      email: email.toLowerCase(),
      password: tempPassword,
      role,
      year_started: year_started || null,
      photo_url: photo_url || null,
    });

    try {
      await emailService.sendWelcomeEmail(user, tempPassword);
    } catch (emailErr) {
      console.error('[register] Welcome email failed:', emailErr.message);
    }

    return res.status(201).json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        year_started: user.year_started,
        photo_url: user.photo_url,
      },
      tempPassword,
    });
  } catch (err) {
    console.error('[register]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// POST /api/auth/login
async function login(req, res) {
  try {
    const { email, password } = req.body;

    if (!email) return validationError(res, 'Email is required');
    if (!isValidEmail(email)) return validationError(res, 'Invalid email address');
    if (!password) return validationError(res, 'Password is required');
    if (password.length < 6) return validationError(res, 'Password must be at least 6 characters');

    const user = await User.findOne({ where: { email: email.toLowerCase() } });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await user.checkPassword(password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = generateToken(user);

    return res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        photo_url: user.photo_url,
      },
    });
  } catch (err) {
    console.error('[login]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// GET /api/auth/me
async function getMe(req, res) {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: ['id', 'name', 'email', 'role', 'photo_url', 'year_started', 'created_at'],
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json({ user });
  } catch (err) {
    console.error('[getMe]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// POST /api/auth/change-password
async function changePassword(req, res) {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword) return validationError(res, 'Current password is required');
    if (!newPassword) return validationError(res, 'New password is required');
    if (newPassword.length < 6) return validationError(res, 'New password must be at least 6 characters');

    const user = await User.findByPk(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const valid = await user.checkPassword(currentPassword);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    user.password = newPassword;
    await user.save();

    return res.json({ success: true });
  } catch (err) {
    console.error('[changePassword]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { register, login, getMe, changePassword };

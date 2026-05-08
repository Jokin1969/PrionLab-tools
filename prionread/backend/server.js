require('dotenv').config();
const express = require('express');
const cors = require('cors');
const routes = require('./routes');
const { sequelize } = require('./models');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok', app: 'prionread' }));
app.use('/api', routes);

// One-time admin setup endpoint — only active when SETUP_TOKEN env var is set.
// Pass plain-text password — the User model's beforeCreate/beforeUpdate hooks hash it.
// Remove SETUP_TOKEN from Railway env vars after use.
app.post('/setup', async (req, res) => {
  const setupToken = process.env.SETUP_TOKEN;
  if (!setupToken) {
    return res.status(404).json({ error: 'Not found' });
  }

  const { token, name, email, password } = req.body;

  if (token !== setupToken) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email and password are required' });
  }

  try {
    const { User } = require('./models');

    const existingAdmin = await User.findOne({ where: { role: 'admin' } });

    if (existingAdmin) {
      // Reset password on existing admin — beforeUpdate hook hashes it once
      existingAdmin.password = password;
      existingAdmin.name = name;
      await existingAdmin.save();
      return res.json({
        success: true,
        message: 'Admin password reset. Remove SETUP_TOKEN from Railway env vars now.',
        admin: { id: existingAdmin.id, name: existingAdmin.name, email: existingAdmin.email },
      });
    }

    // No admin yet — beforeCreate hook hashes the plain password once
    const admin = await User.create({ name, email, password, role: 'admin' });

    res.json({
      success: true,
      message: 'Admin user created. Remove SETUP_TOKEN from Railway env vars now.',
      admin: { id: admin.id, name: admin.name, email: admin.email },
    });
  } catch (err) {
    console.error('[setup]', err);
    res.status(500).json({ error: err.message });
  }
});

// 404
app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));

// Global error handler
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Internal server error' });
});

sequelize.sync({ alter: true })
  .then(() => {
    console.log('Database models synchronized.');
    app.listen(PORT, () => {
      console.log(`PrionRead backend running on port ${PORT}`);

      if (process.env.ENABLE_CRON === 'true') {
        const notificationService = require('./services/notificationService');
        notificationService.initializeScheduledTasks();
      }
    });
  })
  .catch((err) => {
    console.error('Database sync failed, starting anyway:', err.message);
    app.listen(PORT, () => {
      console.log(`PrionRead backend running on port ${PORT}`);
    });
  });

module.exports = app;

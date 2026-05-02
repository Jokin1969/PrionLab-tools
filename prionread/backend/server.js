require('dotenv').config();
const express = require('express');
const cors = require('cors');
const routes = require('./routes');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/health', (_req, res) => res.json({ status: 'ok', app: 'prionread' }));
app.use('/api', routes);

app.listen(PORT, () => {
  console.log(`PrionRead backend running on port ${PORT}`);
});

module.exports = app;

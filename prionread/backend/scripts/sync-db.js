require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { sequelize } = require('../models');

async function syncDatabase() {
  try {
    await sequelize.authenticate();
    console.log('Database connection established.');

    // alter: true updates columns without dropping data; use force: true only in dev to reset
    await sequelize.sync({ alter: true });
    console.log('All models synchronized successfully.');
    process.exit(0);
  } catch (err) {
    console.error('Database sync failed:', err);
    process.exit(1);
  }
}

syncDatabase();

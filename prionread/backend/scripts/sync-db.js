require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { sequelize } = require('../models');

async function syncDatabase() {
  try {
    await sequelize.authenticate();
    console.log('Database connection established.');

    // alter.drop = false: add missing columns only. Plain `alter: true` also
    // DROPS columns that are not in the models (PrionVault's, on the shared
    // `articles` table) and duplicates every unique constraint on each run.
    await sequelize.sync({ alter: { drop: false } });
    console.log('All models synchronized successfully.');
    process.exit(0);
  } catch (err) {
    console.error('Database sync failed:', err);
    process.exit(1);
  }
}

syncDatabase();

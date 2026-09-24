const { Sequelize } = require('sequelize');

// Internal Railway hostnames (*.railway.internal) don't support SSL.
// External/public URLs do — keep rejectUnauthorized:false for self-signed certs.
const isInternalHost = (process.env.DATABASE_URL || '').includes('.railway.internal');

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  dialectOptions: isInternalHost ? {} : {
    ssl: {
      require: true,
      rejectUnauthorized: false,
    },
  },
  logging: process.env.NODE_ENV === 'development' ? console.log : false,
  pool: {
    max: 5,
    min: 0,
    acquire: 30000,
    idle: 10000,
  },
});

module.exports = sequelize;

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const BonusCredit = sequelize.define('BonusCredit', {
  id:             { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  user_id:        { type: DataTypes.UUID, allowNull: false },
  article_id:     { type: DataTypes.UUID, allowNull: true },
  pages:          { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  minutes_earned: { type: DataTypes.INTEGER, allowNull: false },
  note:           { type: DataTypes.TEXT },
  notified_at:    { type: DataTypes.DATE },
}, {
  tableName: 'bonus_credits',
  underscored: true,
  // Partial unique index: only enforce uniqueness when article_id is non-null.
  // PostgreSQL treats NULLs as distinct in unique indexes so this is also handled
  // natively, but the explicit partial index is cleaner.
  indexes: [
    { unique: true, fields: ['user_id', 'article_id'] },
  ],
});

module.exports = BonusCredit;

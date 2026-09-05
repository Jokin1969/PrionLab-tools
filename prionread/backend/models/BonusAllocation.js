const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const BonusAllocation = sequelize.define('BonusAllocation', {
  id:          { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  user_id:     { type: DataTypes.UUID, allowNull: false },
  task_type:   { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'other' },
  description: { type: DataTypes.TEXT, allowNull: false },
  minutes:     { type: DataTypes.INTEGER, allowNull: false },
  created_by:  { type: DataTypes.UUID },
}, {
  tableName: 'bonus_allocations',
  underscored: true,
});

module.exports = BonusAllocation;

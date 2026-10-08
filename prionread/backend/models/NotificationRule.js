const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

module.exports = sequelize.define('NotificationRule', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  type: {
    type: DataTypes.ENUM('articles_remaining', 'articles_percentage'),
    allowNull: false,
  },
  threshold: {
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: { min: 1 },
  },
  target_user_id: {
    type: DataTypes.UUID,
    allowNull: true,
    defaultValue: null,
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
  label: {
    type: DataTypes.STRING(255),
    allowNull: true,
  },
}, {
  tableName: 'notification_rules',
  underscored: true,
});

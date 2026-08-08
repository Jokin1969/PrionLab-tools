const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const UserArticle = sequelize.define('UserArticle', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  user_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' },
  },
  article_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'articles', key: 'id' },
  },
  status: {
    type: DataTypes.ENUM('pending', 'read', 'summarized', 'evaluated'),
    defaultValue: 'pending',
  },
  read_date: {
    type: DataTypes.DATEONLY,
    allowNull: true,
  },
  summary_date: {
    type: DataTypes.DATEONLY,
    allowNull: true,
  },
  evaluation_date: {
    type: DataTypes.DATEONLY,
    allowNull: true,
  },
}, {
  tableName: 'user_articles',
  timestamps: true,
  underscored: true,
  indexes: [
    { unique: true, fields: ['user_id', 'article_id'] },
  ],
});

module.exports = UserArticle;

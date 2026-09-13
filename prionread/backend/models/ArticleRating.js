const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ArticleRating = sequelize.define('ArticleRating', {
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
  rating: {
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: { min: 1, max: 5 },
  },
  comment: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
}, {
  tableName: 'article_ratings',
  timestamps: true,
  underscored: true,
  indexes: [
    { unique: true, fields: ['user_id', 'article_id'] },
  ],
});

module.exports = ArticleRating;

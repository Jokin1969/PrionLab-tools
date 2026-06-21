const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ArticleSummary = sequelize.define('ArticleSummary', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  user_article_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'user_articles', key: 'id' },
  },
  content: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  is_ai_generated: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
}, {
  tableName: 'article_summaries',
  timestamps: true,
  underscored: true,
});

module.exports = ArticleSummary;

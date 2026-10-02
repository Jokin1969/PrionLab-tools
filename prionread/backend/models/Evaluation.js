const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Evaluation = sequelize.define('Evaluation', {
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
  // Array of { question, options: string[], correct: number }
  questions: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: [],
  },
  // Array of student answer indices
  answers: {
    type: DataTypes.JSONB,
    allowNull: true,
    defaultValue: [],
  },
  score: {
    type: DataTypes.FLOAT,
    allowNull: true,
    validate: { min: 0, max: 10 },
  },
  passed: {
    type: DataTypes.BOOLEAN,
    allowNull: true,
  },
}, {
  tableName: 'evaluations',
  timestamps: true,
  underscored: true,
  updatedAt: false,
});

module.exports = Evaluation;

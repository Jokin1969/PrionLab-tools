const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Article = sequelize.define('Article', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  title: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  authors: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  year: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  journal: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  doi: {
    type: DataTypes.STRING,
    unique: true,
    allowNull: true,
  },
  pubmed_id: {
    type: DataTypes.STRING,
    unique: true,
    allowNull: true,
  },
  abstract: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  tags: {
    type: DataTypes.ARRAY(DataTypes.STRING),
    defaultValue: [],
  },
  is_milestone: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  priority: {
    type: DataTypes.INTEGER,
    defaultValue: 3,
    validate: { min: 1, max: 5 },
  },
  dropbox_path: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  dropbox_link: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
}, {
  tableName: 'articles',
  timestamps: true,
  underscored: true,
});

module.exports = Article;

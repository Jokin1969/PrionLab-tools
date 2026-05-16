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
    // PrionVault's ingest worker creates rows for PDFs whose metadata
    // pipeline returned nothing (typically scans, source='no_metadata');
    // those rows arrive with authors / year unknown. Migration 019
    // drops NOT NULL at the DB level; we mirror it here so that
    // sequelize.sync({ alter: true }) doesn't re-add the constraint
    // on every PrionRead backend boot.
    allowNull: true,
  },
  year: {
    type: DataTypes.INTEGER,
    allowNull: true,
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
  is_flagged: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  color_label: {
    type: DataTypes.STRING,
    allowNull: true,
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
  pdf_pages: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
}, {
  tableName: 'articles',
  timestamps: true,
  underscored: true,
});

module.exports = Article;

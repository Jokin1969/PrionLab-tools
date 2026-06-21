const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Article = sequelize.define('Article', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  title: {
    // TEXT instead of STRING(255) so long scientific titles (>255 chars)
    // from CrossRef / PubMed land cleanly. Migration 022 promotes the
    // DB column; mirroring here keeps sequelize.sync({ alter: true })
    // from re-shortening it on every PrionRead backend boot.
    type: DataTypes.TEXT,
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
    // TEXT — see comment on `title`.
    type: DataTypes.TEXT,
    allowNull: true,
  },
  doi: {
    // TEXT — DOIs are usually short but a few publishers (notably
    // book chapters) emit much longer identifiers that overflow 255.
    type: DataTypes.TEXT,
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
    // TEXT — nested paths with long DOI slugs can exceed 255 chars.
    type: DataTypes.TEXT,
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

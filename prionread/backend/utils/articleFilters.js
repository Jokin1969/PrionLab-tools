const { Op } = require('sequelize');

const ALLOWED_SORT = new Set(['year', 'title', 'priority', 'created_at', 'updated_at']);
const DEFAULT_LIMIT = 500;
// Bumped from 500 → 5000 so the admin assignments modal (which needs
// the whole catalogue to compute "unassigned" client-side) can fetch
// every article in one shot. Matches the PrionVault listing cap.
const MAX_LIMIT = 5000;

/**
 * Builds a Sequelize-compatible { where, order, limit, offset } object
 * from Express query params.
 */
function buildArticleQuery(query) {
  const where = {};

  // ?tags=prions,methods  →  rows whose tags array contains ALL supplied tags
  if (query.tags) {
    const tags = query.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (tags.length) where.tags = { [Op.contains]: tags };
  }

  // ?is_milestone=true  (empty string = "Todos", skip filter)
  if (query.is_milestone !== undefined && query.is_milestone !== '') {
    where.is_milestone = query.is_milestone === 'true';
  }

  // ?priority=3
  if (query.priority !== undefined) {
    const p = parseInt(query.priority, 10);
    if (!Number.isNaN(p) && p >= 1 && p <= 5) where.priority = p;
  }

  // ?year=2020
  if (query.year !== undefined && query.year !== '') {
    const y = parseInt(query.year, 10);
    if (!Number.isNaN(y)) where.year = y;
  }

  // ?search=keyword  →  case-insensitive title / authors match
  if (query.search) {
    const pattern = `%${query.search}%`;
    where[Op.or] = [
      { title: { [Op.iLike]: pattern } },
      { authors: { [Op.iLike]: pattern } },
    ];
  }

  const sortField = ALLOWED_SORT.has(query.sort_by) ? query.sort_by : 'created_at';
  const sortOrder = query.order?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const limit = Math.min(parseInt(query.limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const offset = (page - 1) * limit;

  return { where, order: [[sortField, sortOrder]], limit, offset, page };
}

module.exports = { buildArticleQuery };

// Journal Club (read-only) — surfaces the PrionVault-owned
// prionvault_jc_presentation / prionvault_jc_file tables so PrionRead
// students can browse the slides the lab presented for an article.
//
// Mounted at /api/articles/:articleId/jc and /api/jc/files/:fileId/url
// from routes/index.js so both flavours of URL stay sane.

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { getJcForArticle, getJcFileUrl } = require('../controllers/jcController');

const articleScoped = Router({ mergeParams: true });
articleScoped.get('/', authenticate, (req, res, next) => {
  req.params.id = req.params.articleId;
  return getJcForArticle(req, res, next);
});

const fileScoped = Router();
fileScoped.get('/files/:fileId/url', authenticate, getJcFileUrl);

module.exports = { articleScoped, fileScoped };

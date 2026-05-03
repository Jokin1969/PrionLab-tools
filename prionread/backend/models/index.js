const sequelize = require('../config/database');

const User = require('./User');
const Article = require('./Article');
const UserArticle = require('./UserArticle');
const ArticleSummary = require('./ArticleSummary');
const Evaluation = require('./Evaluation');
const ArticleRating = require('./ArticleRating');

// User <-> Article through UserArticle
User.hasMany(UserArticle, { foreignKey: 'user_id', as: 'userArticles' });
Article.hasMany(UserArticle, { foreignKey: 'article_id', as: 'userArticles' });
UserArticle.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
UserArticle.belongsTo(Article, { foreignKey: 'article_id', as: 'article' });

// UserArticle -> ArticleSummary (one summary per user-article pair)
UserArticle.hasOne(ArticleSummary, { foreignKey: 'user_article_id', as: 'summary' });
ArticleSummary.belongsTo(UserArticle, { foreignKey: 'user_article_id', as: 'userArticle' });

// UserArticle -> Evaluation (multiple attempts allowed)
UserArticle.hasMany(Evaluation, { foreignKey: 'user_article_id', as: 'evaluations' });
Evaluation.belongsTo(UserArticle, { foreignKey: 'user_article_id', as: 'userArticle' });

// User/Article -> ArticleRating
User.hasMany(ArticleRating, { foreignKey: 'user_id', as: 'ratings' });
Article.hasMany(ArticleRating, { foreignKey: 'article_id', as: 'ratings' });
ArticleRating.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
ArticleRating.belongsTo(Article, { foreignKey: 'article_id', as: 'article' });

module.exports = {
  sequelize,
  User,
  Article,
  UserArticle,
  ArticleSummary,
  Evaluation,
  ArticleRating,
};

const sequelize = require('../config/database');

const User = require('./User');
const Article = require('./Article');
const UserArticle = require('./UserArticle');
const ArticleSummary = require('./ArticleSummary');
const Evaluation = require('./Evaluation');
const ArticleRating = require('./ArticleRating');
const NotificationRule = require('./NotificationRule');
const NotificationLog = require('./NotificationLog');
const BonusCredit = require('./BonusCredit');
const BonusAllocation = require('./BonusAllocation');

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

// NotificationRule <-> NotificationLog
NotificationRule.hasMany(NotificationLog, { foreignKey: 'rule_id', as: 'logs' });
NotificationLog.belongsTo(NotificationRule, { foreignKey: 'rule_id', as: 'rule' });
NotificationLog.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

// NotificationRule -> target user (optional)
NotificationRule.belongsTo(User, { foreignKey: 'target_user_id', as: 'targetUser' });

// BonusCredit associations
User.hasMany(BonusCredit, { foreignKey: 'user_id', as: 'bonusCredits' });
BonusCredit.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
BonusCredit.belongsTo(Article, { foreignKey: 'article_id', as: 'article' });

// BonusAllocation associations
User.hasMany(BonusAllocation, { foreignKey: 'user_id', as: 'bonusAllocations' });
BonusAllocation.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

module.exports = {
  sequelize,
  User,
  Article,
  UserArticle,
  ArticleSummary,
  Evaluation,
  ArticleRating,
  NotificationRule,
  NotificationLog,
  BonusCredit,
  BonusAllocation,
};

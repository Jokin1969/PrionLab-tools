import api from './api';

export const adminService = {
  // Dashboard
  getDashboard: async (forceRefresh = false) =>
    (await api.get(`/admin/dashboard${forceRefresh ? '?refresh=true' : ''}`)).data,

  // Users
  getUsers: async (filters = {}) => (await api.get(`/users?${new URLSearchParams(filters)}`)).data,
  getUserById: async (userId) => (await api.get(`/users/${userId}`)).data,
  createUser: async (userData) => (await api.post('/auth/register', userData)).data,
  updateUser: async (userId, userData) => (await api.put(`/users/${userId}`, userData)).data,
  deleteUser: async (userId) => (await api.delete(`/users/${userId}`)).data,
  bulkCreateUsers: async (users) => (await api.post('/users/bulk-create', { users })).data,

  resetUserPassword: async (userId, password) =>
    (await api.post(`/admin/users/${userId}/reset-password`, password ? { password } : {})).data,

  sendReminder: async (userId, message) =>
    (await api.post(`/admin/users/${userId}/send-reminder`, { message })).data,

  getWelcomeEmailPreview: async (userId) =>
    (await api.get(`/admin/users/${userId}/welcome-preview`)).data,

  sendWelcomeEmail: async (userId) =>
    (await api.post(`/admin/users/${userId}/send-welcome`)).data,

  getBonusIntroPreview: async (userId, minutes = 200) =>
    (await api.get(`/admin/users/${userId}/bonus-intro-preview?minutes=${minutes}`)).data,

  sendBonusIntroEmail: async (userId, minutes = 200) =>
    (await api.post(`/admin/users/${userId}/send-bonus-intro`, { minutes })).data,

  // Assignments
  getUserAssignments: async (userId) => (await api.get(`/assignments/user/${userId}`)).data,
  assignArticles: async (userId, articleIds) =>
    (await api.post('/assignments', { user_id: userId, article_ids: articleIds })).data,
  removeAssignment: async (assignmentId) => (await api.delete(`/assignments/${assignmentId}`)).data,
  bulkAssign: async (userIds, articleIds) =>
    (await api.post('/assignments/bulk', { user_ids: userIds, article_ids: articleIds })).data,
  assignArticleToAll: async (articleId) =>
    (await api.post(`/admin/articles/${articleId}/assign-to-all`)).data,
  getAssignmentsMatrix: async () => (await api.get('/admin/articles/assignments-matrix')).data,

  // Articles
  getArticles: async (filters = {}) => (await api.get(`/articles?${new URLSearchParams(filters)}`)).data,
  getArticleById: async (articleId) => (await api.get(`/articles/${articleId}`)).data,
  createArticle: async (formData) =>
    (await api.post('/articles', formData, { headers: { 'Content-Type': 'multipart/form-data' } })).data,
  updateArticle: async (articleId, formData) =>
    (await api.put(`/articles/${articleId}`, formData, { headers: { 'Content-Type': 'multipart/form-data' } })).data,
  deleteArticle: async (articleId) => (await api.delete(`/articles/${articleId}`)).data,
  fetchMetadata: async (doi, pubmedId) =>
    (await api.post('/articles/fetch-metadata', { doi, pubmed_id: pubmedId })).data,
  getArticlePdfLink: async (articleId) =>
    (await api.post(`/articles/${articleId}/download-link`)).data,

  exportArticlesWord: async (articles) =>
    api.post('/admin/articles/export-word', { articleIds: articles.map((a) => a.id) }, { responseType: 'blob' }),

  // PDF health
  verifyPdfs: async () => (await api.post('/admin/articles/verify-pdfs')).data,
  clearPdfLink: async (articleId) => (await api.delete(`/articles/${articleId}/pdf-link`)).data,
  syncDropboxPdfs: async () => (await api.post('/admin/articles/sync-dropbox')).data,

  // Duplicate detection
  findDuplicates: async () => (await api.get('/admin/articles/find-duplicates')).data,

  // PDF -> metadata analysis
  analyzePdf: async (file) => {
    const fd = new FormData();
    fd.append('pdf', file);
    return (await api.post('/articles/analyze-pdf', fd, { headers: { 'Content-Type': 'multipart/form-data' } })).data;
  },

  // PrionVault <-> PrionRead sync
  getSyncStatus: async () => (await api.get('/admin/sync/status')).data,
  runPrionVaultMigration: async () => (await api.post('/admin/sync/run-migration')).data,
  markPendingForPrionVault: async () => (await api.post('/admin/sync/mark-pending')).data,
  backfillPdfPages: async (limit = 50) => (await api.post('/admin/sync/backfill-pdf-pages', { limit })).data,
  backfillStatus: async () => (await api.post('/admin/sync/backfill-status')).data,

  // Notification rules
  getNotificationRules: async () => (await api.get('/admin/notification-rules')).data,
  createNotificationRule: async (data) => (await api.post('/admin/notification-rules', data)).data,
  updateNotificationRule: async (id, data) => (await api.patch(`/admin/notification-rules/${id}`, data)).data,
  deleteNotificationRule: async (id) => (await api.delete(`/admin/notification-rules/${id}`)).data,
  runNotificationRules: async () => (await api.post('/admin/notification-rules/run')).data,

  // Monthly report
  runMonthlyReport: async () => (await api.post('/admin/monthly-report/run')).data,
  getMonthlyReportPreview: async (userId) => api.get(`/admin/monthly-report/preview/${userId}`, { responseType: 'text' }),

  // PrionBonus
  getAdminBonus: async () => (await api.get('/admin/bonus')).data,
  getStudentBonusDetail: async (userId) => (await api.get(`/admin/bonus/${userId}`)).data,
  addBonusAllocation: async (data) => (await api.post('/admin/bonus/allocations', data)).data,
  deleteBonusAllocation: async (id) => (await api.delete(`/admin/bonus/allocations/${id}`)).data,
};

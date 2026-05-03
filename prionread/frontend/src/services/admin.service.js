import api from './api';

export const adminService = {
  // Dashboard
  getDashboard: async () => (await api.get('/admin/dashboard')).data,

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
  updateArticle: async (articleId, formData) => (await api.put(`/articles/${articleId}`, formData)).data,
  deleteArticle: async (articleId) => (await api.delete(`/articles/${articleId}`)).data,
  fetchMetadata: async (doi, pubmedId) =>
    (await api.post('/articles/fetch-metadata', { doi, pubmed_id: pubmedId })).data,
  getArticlePdfLink: async (articleId) =>
    (await api.post(`/articles/${articleId}/download-link`)).data,
};

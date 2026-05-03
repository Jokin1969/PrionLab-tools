import api from './api';

export const adminService = {
  // Dashboard
  getDashboard: async () => {
    const response = await api.get('/admin/dashboard');
    return response.data;
  },

  // Users
  getUsers: async (filters = {}) => {
    const params = new URLSearchParams(filters);
    const response = await api.get(`/users?${params}`);
    return response.data;
  },

  getUserById: async (userId) => {
    const response = await api.get(`/users/${userId}`);
    return response.data;
  },

  createUser: async (userData) => {
    const response = await api.post('/auth/register', userData);
    return response.data;
  },

  updateUser: async (userId, userData) => {
    const response = await api.put(`/users/${userId}`, userData);
    return response.data;
  },

  deleteUser: async (userId) => {
    const response = await api.delete(`/users/${userId}`);
    return response.data;
  },

  bulkCreateUsers: async (users) => {
    const response = await api.post('/users/bulk-create', { users });
    return response.data;
  },

  resetUserPassword: async (userId, password) => {
    const response = await api.post(
      `/admin/users/${userId}/reset-password`,
      password ? { password } : {}
    );
    return response.data;
  },

  sendReminder: async (userId, message) => {
    const response = await api.post(`/admin/users/${userId}/send-reminder`, { message });
    return response.data;
  },

  // Assignments
  getUserAssignments: async (userId) => {
    const response = await api.get(`/assignments/user/${userId}`);
    return response.data;
  },

  assignArticles: async (userId, articleIds) => {
    const response = await api.post('/assignments', { user_id: userId, article_ids: articleIds });
    return response.data;
  },

  removeAssignment: async (assignmentId) => {
    const response = await api.delete(`/assignments/${assignmentId}`);
    return response.data;
  },

  bulkAssign: async (userIds, articleIds) => {
    const response = await api.post('/assignments/bulk', { user_ids: userIds, article_ids: articleIds });
    return response.data;
  },

  assignArticleToAll: async (articleId) => {
    const response = await api.post(`/admin/articles/${articleId}/assign-to-all`);
    return response.data;
  },

  // Articles
  getArticles: async (filters = {}) => {
    const params = new URLSearchParams(filters);
    const response = await api.get(`/articles?${params}`);
    return response.data;
  },

  getArticleById: async (articleId) => {
    const response = await api.get(`/articles/${articleId}`);
    return response.data;
  },

  createArticle: async (formData) => {
    const response = await api.post('/articles', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data;
  },

  updateArticle: async (articleId, formData) => {
    const response = await api.put(`/articles/${articleId}`, formData);
    return response.data;
  },

  deleteArticle: async (articleId) => {
    const response = await api.delete(`/articles/${articleId}`);
    return response.data;
  },

  fetchMetadata: async (doi, pubmedId) => {
    const response = await api.post('/articles/fetch-metadata', { doi, pubmed_id: pubmedId });
    return response.data;
  },

  // Reports
  bulkCreateUsers: async (users) => {
    const response = await api.post('/users/bulk-create', { users });
    return response.data;
  },
};

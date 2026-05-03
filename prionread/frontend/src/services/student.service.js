import api from './api';

export const studentService = {
  getDashboard: async () => {
    const response = await api.get('/my-dashboard');
    return response.data;
  },

  getMyArticles: async (filters = {}) => {
    const params = new URLSearchParams(filters);
    const response = await api.get(`/my-articles?${params}`);
    return response.data;
  },

  markAsRead: async (articleId) => {
    const response = await api.put(`/my-articles/${articleId}/mark-as-read`);
    return response.data;
  },

  getArticleDetail: async (articleId) => {
    const response = await api.get(`/my-articles/${articleId}`);
    return response.data;
  },
};

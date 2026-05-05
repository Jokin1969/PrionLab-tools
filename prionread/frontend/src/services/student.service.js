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

  createSummary: async (articleId, content, isAiGenerated = false) => {
    const response = await api.post(`/my-articles/${articleId}/summary`, {
      content,
      is_ai_generated: isAiGenerated,
    });
    return response.data;
  },

  getSummary: async (articleId) => {
    const response = await api.get(`/my-articles/${articleId}/summary`);
    return response.data;
  },

  generateAISummary: async (articleId) => {
    const response = await api.post(`/my-articles/${articleId}/generate-ai-summary`);
    return response.data;
  },

  generateEvaluation: async (articleId) => {
    const response = await api.post(`/my-articles/${articleId}/generate-evaluation`);
    return response.data;
  },

  submitEvaluation: async (articleId, questions, answers) => {
    const response = await api.post(`/my-articles/${articleId}/submit-evaluation`, {
      questions,
      answers,
    });
    return response.data;
  },

  getEvaluation: async (articleId) => {
    const response = await api.get(`/my-articles/${articleId}/evaluation`);
    return response.data;
  },

  rateArticle: async (articleId, rating, comment) => {
    const response = await api.post(`/articles/${articleId}/ratings`, {
      rating,
      comment,
    });
    return response.data;
  },

  getArticleRatings: async (articleId) => {
    const response = await api.get(`/articles/${articleId}/ratings`);
    return response.data;
  },

  getPdfLink: async (articleId) => {
    const response = await api.get(`/articles/${articleId}/pdf/link`);
    return response.data;
  },
};

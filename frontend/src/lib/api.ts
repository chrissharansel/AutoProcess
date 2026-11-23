import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';

const api = axios.create({
  baseURL: API_URL,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  try {
    const ws = JSON.parse(localStorage.getItem('workspace') || 'null');
    if (ws?.id) config.headers['x-workspace-id'] = ws.id;   // the server verifies membership on every request
  } catch { /* ignore */ }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      localStorage.removeItem('workspace');
      if (!window.location.pathname.includes('/login')) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(err);
  }
);

export const errMsg = (e: any, fallback = 'Something went wrong.') => {
  const d = e?.response?.data;
  return [d?.error, Array.isArray(d?.details) ? d.details.slice(0, 5).join('; ') : d?.details].filter(Boolean).join(' — ') || e?.message || fallback;
};

export default api;

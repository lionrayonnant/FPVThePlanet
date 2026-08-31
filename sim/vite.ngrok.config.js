import config from './vite.config.js';

export default {
  ...config,
  server: {
    ...config.server,
    host: '0.0.0.0',
    allowedHosts: ['periodic-rio-arise-bond.trycloudflare.com'],
  },
};

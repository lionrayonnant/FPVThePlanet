import config from './vite.config.js';

export default {
  ...config,
  server: {
    ...config.server,
    host: '0.0.0.0',
    allowedHosts: ['treat-durably-empirical.ngrok-free.dev'],
  },
};

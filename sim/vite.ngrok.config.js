import config from './vite.config.js';

export default {
  ...config,
  server: {
    ...config.server,
    allowedHosts: ['treat-durably-empirical.ngrok-free.dev'],
  },
};

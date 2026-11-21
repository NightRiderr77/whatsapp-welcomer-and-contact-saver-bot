// WhatsApp Welcomer & Contact Saver Bot — PM2 config, for running without Docker.
// Built by NightRiderr77 · Property of PXN STORES LK
//
//   npm install
//   pm2 start ecosystem.config.js
//   pm2 logs welcomer-bot     # scan the QR here on the first run
//   pm2 save && pm2 startup    # survive a reboot
module.exports = {
  apps: [
    {
      name         : 'welcomer-bot',
      script       : 'owner-bot.js',
      autorestart  : true,
      max_restarts : 50,
      restart_delay: 4000,
      // Chromium lives outside the Node heap; this caps only Node itself.
      node_args    : '--max-old-space-size=256',
      env: {
        // Required for the dashboard; without it the panel does not start.
        DASH_PASSWORD: process.env.DASH_PASSWORD || '',
        DASH_PORT    : process.env.DASH_PORT     || '8091',
        // Loopback only: the panel is plain HTTP. Reach it over an SSH tunnel.
        DASH_HOST    : process.env.DASH_HOST     || '127.0.0.1',
        // Link with an 8-digit code instead of a QR.
        PAIR_NUMBER: process.env.PAIR_NUMBER || '',
        // Set when the system Chromium is not where Puppeteer expects it.
        PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || '',
      },
    },
  ],
};

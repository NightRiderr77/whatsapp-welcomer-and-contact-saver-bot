// PM2 config, for running without Docker.
//
//   npm install
//   pm2 start ecosystem.config.js
//   pm2 logs pxn-owner-bot     # scan the QR here on the first run
//   pm2 save && pm2 startup    # survive a reboot
module.exports = {
  apps: [
    {
      name         : 'pxn-owner-bot',
      script       : 'owner-bot.js',
      autorestart  : true,
      max_restarts : 50,
      restart_delay: 4000,
      // Chromium lives outside the Node heap; this caps only Node itself.
      node_args    : '--max-old-space-size=256',
      env: {
        // Link with an 8-digit code instead of a QR.
        PAIR_NUMBER: process.env.PAIR_NUMBER || '',
        // Set when the system Chromium is not where Puppeteer expects it.
        PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || '',
      },
    },
  ],
};

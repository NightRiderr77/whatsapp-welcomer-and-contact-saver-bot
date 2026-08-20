# Chromium comes from Alpine's repo rather than Puppeteer's download, which
# keeps the image small and works on arm64 VPSes as well as x86.
FROM node:20-alpine

RUN apk add --no-cache \
      chromium nss freetype harfbuzz ca-certificates ttf-freefont tini

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY owner-bot.js dashboard.js settings.example.json ./

EXPOSE 8091

# The session and the state files must outlive the container, or every deploy
# asks the owner to scan a QR again and re-greets every customer. See the
# volumes in docker-compose.yml.
VOLUME ["/app/.wwebjs_auth", "/app/state"]

# tini reaps the Chromium children; without it they pile up as zombies.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "owner-bot.js"]

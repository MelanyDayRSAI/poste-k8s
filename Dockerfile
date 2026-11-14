FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.js db.js ./
COPY public ./public
USER node
EXPOSE 500
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:500/api/health || exit 1
CMD ["node", "server.js"]

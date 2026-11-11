# Image de production Pay243 (Easypanel, ou tout hôte Docker)
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

# Dépendances d'abord : la couche est réutilisée tant que package*.json ne change pas
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY sdk ./sdk

# Pièces d'identité chiffrées : à monter sur un volume persistant (/app/data)
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null || exit 1

CMD ["node", "src/server.js"]

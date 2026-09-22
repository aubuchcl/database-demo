FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY server.js db.js ./
COPY public ./public

USER node
EXPOSE 8080
CMD ["node", "server.js"]

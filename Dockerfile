# API do ufba.app (platform). Imagem única: build + migrações no start.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
# node_modules inteiro: o CLI do Prisma (migrate deploy) está nas devDependencies.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json prisma.config.ts ./
COPY prisma ./prisma
COPY certs ./certs
COPY config ./config
USER node
EXPOSE 3000
# Migrações primeiro (idempotente); se falharem, o container não sobe.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/main.js"]

FROM node:22-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update -y && apt-get install -y openssl

COPY package.json package-lock.json ./
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src

RUN npm ci
RUN npx prisma generate --schema=src/database/prisma/schema.prisma
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runner

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update -y && apt-get install -y openssl

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/database/prisma ./src/database/prisma

EXPOSE 5001

CMD ["node", "dist/main"]

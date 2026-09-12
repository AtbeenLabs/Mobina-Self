# مرحله ۱: Build
FROM node:22-alpine AS builder

# نصب ابزارهای لازم برای کامپایل better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# مرحله ۲: Production
FROM node:22-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/webapp ./webapp

EXPOSE 3000

CMD ["node", "dist/bot.js"]
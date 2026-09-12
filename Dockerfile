FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build # اگر TypeScript دارید، این کامپایل را انجام می‌دهد

EXPOSE 3000

CMD ["node", "dist/bot.js"] # مسیر فایل کامپایل‌شده نهایی
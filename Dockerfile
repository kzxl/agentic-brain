FROM node:20-bookworm-slim
WORKDIR /app

ENV NODE_ENV=production

# Cài đặt dependencies (reproducible)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy mã nguồn
COPY . .

# Mở port cho SemanticBrain và Proxy
EXPOSE 3457 3458

# Chạy lệnh mặc định (có thể bị ghi đè bởi docker-compose)
CMD ["npm", "run", "start"]

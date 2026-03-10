# Multi-stage Dockerfile
# 1) Build the frontend (Vite)
# 2) Install production deps for backend and copy frontend build into server/public

FROM node:18-alpine AS builder
WORKDIR /app

# Install frontend deps and build
COPY frontend/package*.json ./frontend/
WORKDIR /app/frontend
RUN npm install --silent
COPY frontend .
RUN npm run build

FROM node:18-alpine AS runtime
WORKDIR /app

# Install backend production dependencies
COPY server/package*.json ./server/
WORKDIR /app/server
RUN npm install --omit=dev --silent

# Copy backend source
COPY server ./server

# Copy built frontend into backend public folder
COPY --from=builder /app/frontend/dist ./server/public

WORKDIR /app/server
EXPOSE 5000

CMD ["node", "server.js"]

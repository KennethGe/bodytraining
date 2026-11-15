# ---- 构建阶段：前端产物 ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build -w web

# ---- 运行阶段 ----
FROM node:24-alpine AS run
WORKDIR /app
RUN apk add --no-cache python3 py3-pip
COPY --from=build /app /app
# 佳明 sidecar 依赖（非官方通道，可选）
RUN python3 -m venv /app/server/sidecar/.venv \
    && /app/server/sidecar/.venv/bin/pip install --no-cache-dir -q garminconnect \
    || echo "warn: garminconnect install failed (garmin sync disabled)"
VOLUME ["/app/data"]
ENV PORT=3001 NODE_ENV=production
EXPOSE 3001
CMD ["npm", "run", "start", "-w", "server"]

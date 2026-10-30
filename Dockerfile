# 用 Debian slim(glibc): 长桥 SDK 等原生模块不支持 Alpine(musl)
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3457
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# 可选的券商 SDK, 构建时用 build arg 打开, 例如: docker compose build --build-arg EXTRA_PACKAGES=longport
ARG EXTRA_PACKAGES=""
RUN if [ -n "$EXTRA_PACKAGES" ]; then npm install --omit=dev --no-save $EXTRA_PACKAGES; fi
COPY . .
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 3457
CMD ["node", "server.js"]

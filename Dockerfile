FROM node:22-alpine AS builder
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
RUN apk add --no-cache ffmpeg unzip ca-certificates
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/app/data

COPY --from=builder /build/package.json ./package.json
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/assets ./assets
COPY --from=builder /build/comfyui_workflows ./comfyui_workflows

RUN mkdir -p /app/data/references /app/data/videos /app/data/music /app/data/temp
VOLUME ["/app/data"]
EXPOSE 8080
CMD ["node", "dist/server/index.js"]

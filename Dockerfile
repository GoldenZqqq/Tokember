FROM node:22-bookworm AS build
WORKDIR /workspace

COPY package.json package-lock.json ./
COPY contracts/package.json ./contracts/package.json
COPY server/package.json ./server/package.json
COPY collector/package.json ./collector/package.json
COPY web/package.json ./web/package.json
RUN npm ci

COPY contracts ./contracts
COPY server ./server
COPY web ./web
COPY scripts ./scripts
RUN npm run build -w server && npm run build -w web
RUN npm prune --omit=dev

ARG TOKEMBER_COMMIT
ARG TOKEMBER_BUILT_AT
RUN test -n "$TOKEMBER_COMMIT" && test -n "$TOKEMBER_BUILT_AT" \
    && node scripts/stage-release.mjs \
      --workspace /workspace \
      --output /release \
      --commit "$TOKEMBER_COMMIT" \
      --built-at "$TOKEMBER_BUILT_AT" \
      --node-version "$(node -p 'process.version')" \
      --architecture "$(node -p 'process.arch')"

FROM scratch AS release-export
COPY --from=build /release/ /

FROM node:22-bookworm-slim AS runtime
WORKDIR /app/current/server
COPY --from=build /release/ /app/current/
ENV NODE_ENV=production
ENV PORT=3147
ENV DB_PATH=/data/tokember.db
ENV TOKEMBER_BUILD_METADATA=/app/current/release.json
EXPOSE 3147
VOLUME /data
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=4 \
  CMD ["node", "/app/current/scripts/healthcheck.mjs", "http://127.0.0.1:3147/api/health/ready"]
CMD ["node", "dist/index.js"]

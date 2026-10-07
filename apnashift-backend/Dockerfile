# ApnaShift backend — production image (Railway + CI use this).
# No secrets are baked in: DATABASE_URL / JWT_SECRET / GEOAPIFY_API_KEY
# always come from the runtime environment (Railway variables / CI secrets).
# Frontend is served from ./public (already committed in the repo).
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:20-slim AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY db ./db
COPY scripts ./scripts
COPY public ./public
COPY openapi.yaml ./
# Railway injects PORT; default 3000 for local docker runs.
ENV PORT=3000
EXPOSE 3000
# NOTE: migrations are NOT run at container boot (CI runs db:migrate
# explicitly before deploy — never auto-migrate inside a release command).
CMD ["node", "src/server.js"]

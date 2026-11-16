# Prelaunch launch-readiness scan as an Apify Actor.
# Build context is the repository root (where .actor/ lives), so the Actor
# bundles the same lib/ scan code the website runs.
# The base image ships Chromium for Playwright; keep its tag and the
# "playwright" version in apify/package.json in step.

FROM apify/actor-node-playwright-chrome:24-1.65.1 AS builder
COPY --chown=myuser:myuser apify/package*.json ./
RUN npm ci --no-audit --no-fund --loglevel=error
COPY --chown=myuser:myuser lib ./lib
COPY --chown=myuser:myuser apify/src ./apify/src
RUN npx esbuild apify/src/main.ts --bundle --platform=node --format=esm --target=node22 \
      --packages=external --outfile=dist/main.js

FROM apify/actor-node-playwright-chrome:24-1.65.1
COPY --chown=myuser:myuser apify/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund --loglevel=error \
    && node --version && npm --version
COPY --from=builder --chown=myuser:myuser /home/myuser/dist ./dist
CMD ["node", "dist/main.js"]

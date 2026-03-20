FROM node:22-slim

RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation fonts-noto-color-emoji \
    libgtk-3-0 libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 \
    libgbm1 libpango-1.0-0 libcairo2 libasound2 libxshmfence1 \
    libatk1.0-0 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
    git curl \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g agent-browser

ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV PORT=8788
ENV SMOLPAWS_WORKSPACE_ROOT=/workspace
ENV SMOLPAWS_PERSISTENCE_DIR=/workspace/persistence

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY src ./src
COPY tsconfig.json ./tsconfig.json

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 --ingroup nodejs nodejs \
    && mkdir -p /workspace/group /workspace/project /workspace/global /workspace/persistence \
    && chown -R nodejs:nodejs /app /workspace

USER nodejs

EXPOSE 8788

CMD ["npm", "run", "runner:start"]

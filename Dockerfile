# Imagen del motor de fábrica-videos: el mismo motor Remotion (VideoEngine)
# más la API HTTP (server/) para recibir trabajos desde n8n y devolver el MP4.
#
# Basado en la imagen recomendada por Remotion para self-hosting en Linux:
# https://www.remotion.dev/docs/docker
FROM node:22-bookworm-slim

# Dependencias de Chrome Headless Shell.
RUN apt-get update && apt-get install -y --no-install-recommends \
  libnss3 \
  libdbus-1-3 \
  libatk1.0-0 \
  libgbm-dev \
  libasound2 \
  libxrandr2 \
  libxkbcommon-dev \
  libxfixes3 \
  libxcomposite1 \
  libxdamage1 \
  libatk-bridge2.0-0 \
  libpango-1.0-0 \
  libcairo2 \
  libcups2 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY tsconfig.json remotion.config.ts ./
COPY src ./src
COPY public ./public
COPY server ./server

RUN npm ci

# Descarga Chrome Headless Shell (queda horneado en la imagen).
RUN npx remotion browser ensure

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["node", "server/index.mjs"]

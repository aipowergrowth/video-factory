# Imagen del motor de fábrica-videos: el mismo motor Remotion (VideoEngine)
# más la API HTTP (server/) para recibir trabajos desde n8n y devolver el MP4.
#
# Basado en la imagen recomendada por Remotion para self-hosting en Linux:
# https://www.remotion.dev/docs/docker

# ---- Etapa 1: compilar whisper.cpp + descargar el modelo -----------------
# Aparte, con sus propias herramientas de compilación (gcc/cmake/git), para
# que NO queden en la imagen final — solo se copia el binario ya compilado.
FROM node:22-bookworm AS whisper-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
  build-essential cmake git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY server/install-whisper.mjs ./install-whisper.mjs
# "small": buen equilibrio calidad/velocidad para español en el VPS (ver
# README para cómo medimos esto). Se puede subir a "medium" más adelante
# si la calidad no alcanza, a costa de más tiempo de transcripción.
ENV WHISPER_MODEL=small
RUN node install-whisper.mjs

# ---- Etapa 2: imagen final, liviana ---------------------------------------
FROM node:22-bookworm-slim

# Dependencias de Chrome Headless Shell + libgomp (whisper.cpp la necesita
# en tiempo de ejecución para el paralelismo de la inferencia).
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
  libgomp1 \
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

# whisper.cpp ya compilado + modelo, de la etapa anterior — listo para usar
# sin instalar ni descargar nada en tiempo de ejecución.
COPY --from=whisper-builder /build/whisper.cpp ./whisper.cpp

ENV NODE_ENV=production
ENV PORT=3001
ENV WHISPER_MODEL=small

EXPOSE 3001

CMD ["node", "server/index.mjs"]

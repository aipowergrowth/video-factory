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

# whisper.cpp detecta las instrucciones del CPU de ESTA máquina (el runner
# de CI) leyendo /proc/cpuinfo en su propio Makefile, y las hornea en el
# binario final. Si el runner soporta AVX-512 y el host donde termina
# corriendo no, el binario arranca y muere con SIGILL en el primer uso
# real (nos pasó: la Etapa 1 transcribió bien, un build posterior
# compilado en un runner distinto no). Por eso se clona y compila a mano
# aquí en vez de usar installWhisperCpp() de @remotion/install-whisper-cpp
# — esa función no deja pasar variables al `make` — forzando un build
# portable: como mucho AVX2/FMA/F16C (universales en cualquier x86_64 de
# los últimos ~10 años), nunca AVX-512. installWhisperCpp() más abajo ve
# que whisper.cpp/main ya existe y no vuelve a compilar nada.
RUN git clone --quiet https://github.com/ggerganov/whisper.cpp.git whisper.cpp \
  && cd whisper.cpp \
  && git checkout --quiet v1.5.5 \
  && make AVX512F_M= AVX512VNNI_M= AVX512VBMI_M= \
  && cd .. \
  && ./whisper.cpp/main --help >/dev/null \
  && echo "whisper.cpp: binario portable (sin AVX-512) arrancó bien en el build"

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

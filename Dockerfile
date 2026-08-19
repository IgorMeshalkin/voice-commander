FROM node:24-bookworm AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    gir1.2-gtk-3.0 \
    ffmpeg \
    gjs \
    libgomp1 \
    libvulkan1 \
    pulseaudio-utils \
    x11-xserver-utils \
    xdotool \
    xinput \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY docker/entrypoint.sh /usr/local/bin/voice-commander-entrypoint
COPY vendor/whisper.cpp/build/bin/ ./vendor/whisper.cpp/build/bin/
COPY vendor/whisper.cpp/models/ggml-small-q5_1.bin ./vendor/whisper.cpp/models/ggml-small-q5_1.bin

RUN chmod +x /usr/local/bin/voice-commander-entrypoint

ENV NODE_ENV=production
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
ENV LD_LIBRARY_PATH=/app/vendor/whisper.cpp/build/bin
ENTRYPOINT ["/usr/local/bin/voice-commander-entrypoint"]

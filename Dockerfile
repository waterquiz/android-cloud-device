# ==============================================================================
# Android Cloud Device - Production Dockerfile for Railway
# ==============================================================================

FROM debian:bookworm-slim

# Avoid prompts from debconf during build
ENV DEBIAN_FRONTEND=noninteractive

# 1. Install required system packages, QEMU emulator, ADB, aapt, Node.js & runtime tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    qemu-system-x86 \
    qemu-utils \
    adb \
    aapt \
    nodejs \
    npm \
    curl \
    wget \
    file \
    ca-certificates \
    procps \
    socat \
    dos2unix \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 2. Set application working directory
WORKDIR /app

# 3. Create persistent directories and app skeleton
RUN mkdir -p /app/config /app/server /data /data/android /data/apks /data/logs

# 4. Copy configuration, server code, and startup script
COPY config/ /app/config/
COPY server/ /app/server/
COPY start.sh /app/start.sh

# 5. Ensure LF line endings and executable permission for start.sh
RUN dos2unix /app/start.sh && chmod +x /app/start.sh

# 6. Install production server dependencies
WORKDIR /app/server
RUN npm install --omit=dev && npm cache clean --force

# 7. Return to main application directory
WORKDIR /app

# 8. Railway configuration (dynamic $PORT support)
# Persistent data volume should be mounted at /data via Railway Dashboard (Volumes tab)
ENV PORT=8080
ENV DATA_DIR=/data
ENV ACCESS_TOKEN=Fraz1234
ENV ALLOW_SOFTWARE_EMULATION=true
ENV ANDROID_IMAGE_URL=https://archive.org/download/android-x86-8.1-r6/android-x86-8.1-r6.iso
EXPOSE 8080

# 10. Start the Android Cloud Device supervisor
CMD ["/app/start.sh"]

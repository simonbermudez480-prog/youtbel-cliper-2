FROM node:18-slim AS base

# Install system dependencies: FFmpeg, yt-dlp, Python (for yt-dlp)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install/upgrade yt-dlp to latest
RUN pip3 install --no-cache-dir --break-system-packages yt-dlp

WORKDIR /app

# Install Node.js dependencies
COPY package.json ./
RUN npm install --production

# Copy source code
COPY src/ ./src/

# Create temp directory
RUN mkdir -p /tmp/yt-clipper

ENV TMP_DIR=/tmp/yt-clipper

EXPOSE 10000

# Render sets PORT via env var, so don't hardcode it here
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -f http://localhost:${PORT:-3000}/health || exit 1

# Render provides PORT env var (typically 10000)
CMD ["sh", "-c", "node src/server.js"]
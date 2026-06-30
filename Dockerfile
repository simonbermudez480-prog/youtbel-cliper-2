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
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "src/server.js"]
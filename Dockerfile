# Use official Node.js runtime with Debian 12 Bookworm (glibc 2.36+)
FROM node:20-bookworm-slim

# Install system dependencies: ffmpeg, python3, pip, curl, unzip
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg python3 python3-pip curl unzip ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Install Deno (glibc 2.36 compatible)
RUN curl -fsSL https://deno.land/install.sh | sh && \
    mv /root/.deno/bin/deno /usr/local/bin/

# Install the latest pre-release yt-dlp with all extras (yt-dlp-ejs, pycryptodomex, mutagen, etc.)
RUN pip3 install --no-cache-dir --upgrade --break-system-packages --pre "yt-dlp[default]" yt-dlp-ejs

# Set working directory
WORKDIR /app

# Copy package manifests and install production dependencies
COPY package*.json ./
RUN npm install --production

# Copy application source code
COPY . .

# Ensure temp directory exists and is writable
RUN mkdir -p temp

# Expose port (Render/Koyeb default or dynamic PORT)
ENV PORT=3000
EXPOSE 3000

# Start Express server
CMD ["npm", "start"]

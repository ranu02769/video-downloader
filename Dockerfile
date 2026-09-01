# Use official Node.js runtime as the base image
FROM node:20-bullseye-slim

# Install system dependencies: ffmpeg, python3, pip, curl, unzip
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg python3 python3-pip curl unzip ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Install Deno (required by modern yt-dlp to solve YouTube JS signatures)
RUN curl -fsSL https://deno.land/install.sh | sh && \
    mv /root/.deno/bin/deno /usr/local/bin/

# Install the latest yt-dlp from master with all latest YouTube anti-bot patches
RUN pip3 install --no-cache-dir --upgrade --force-reinstall "https://github.com/yt-dlp/yt-dlp/archive/master.tar.gz"

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

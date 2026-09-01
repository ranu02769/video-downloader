# Use official Node.js runtime as the base image
FROM node:20-bullseye-slim

# Install system dependencies: ffmpeg, python3, pip
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg python3 python3-pip && \
    rm -rf /var/lib/apt/lists/*

# Install the latest yt-dlp via pip
RUN pip3 install --no-cache-dir --upgrade yt-dlp

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

FROM node:20-slim

# Baileys needs "git" to fetch one of its dependencies (libsignal) directly
# from GitHub, and needs git configured to use HTTPS instead of SSH since
# this container has no SSH keys.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && git config --global url."https://github.com/".insteadOf "git@github.com:" \
    && git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application code
COPY . .

# Start the bot
CMD ["node", "whatsapp_sender_clean.js"]

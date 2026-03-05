# Use official Playwright image - has Chromium + all dependencies pre-installed
FROM mcr.microsoft.com/playwright:v1.41.0-jammy

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
RUN npm install

# Copy app files
COPY . .

# Expose port
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]

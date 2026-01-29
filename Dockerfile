FROM node:20-alpine

WORKDIR /app

# Install git to clone the repo (for standalone deployment)
RUN apk add --no-cache git

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy application code
COPY . .

# Expose port
EXPOSE 3000

# Start the application
CMD ["node", "index.js"]

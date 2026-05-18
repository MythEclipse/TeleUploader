# Stage 1: Builder
FROM oven/bun:1.1-alpine AS builder

WORKDIR /usr/src/app

# Install dependencies (including devDependencies for build and lint)
COPY package.json tsconfig.json biome.json ./
RUN bun install

# Copy src and test directories
COPY src ./src
COPY test ./test

# Run lint and build
RUN bun run lint
RUN bun run build

# Stage 2: Runner
FROM oven/bun:1.1-slim AS runner

WORKDIR /usr/src/app

# Copy built files, schema, and package.json
COPY --from=builder /usr/src/app/dist/index.js ./dist/index.js
COPY schema.sql ./
COPY package.json ./

# Expose port
EXPOSE 3000

# Start server
CMD ["bun", "dist/index.js"]

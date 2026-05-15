# claude-tty POC
#
# Browser <--ws--> this container <--pty--> claude CLI
#
# Build:  docker build -t claude-tty-poc .
# Run:    docker run --rm -p 4096:4096 \
#           -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
#           claude-tty-poc
# Then:   open http://localhost:4096

FROM node:20-bookworm-slim

# Build deps for node-pty's native binding + git for the optional repo clone.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates bash python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code@latest

WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund

COPY server.js ./
COPY public ./public
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

RUN useradd -m -u 1001 -s /bin/bash sandbox \
    && mkdir -p /work/repo \
    && chown -R sandbox:sandbox /work /app

ENV PORT=4096
ENV REPO_DIR=/work/repo
ENV POC_CMD=claude
ENV TERM=xterm-256color

EXPOSE 4096
USER sandbox
WORKDIR /work/repo

ENTRYPOINT ["/entrypoint.sh"]

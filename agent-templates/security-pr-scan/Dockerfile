FROM node:22-slim

# Security scanning tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# gh CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# semgrep (pinned)
RUN pip3 install --no-cache-dir --break-system-packages semgrep==1.72.0

# gitleaks (pinned) — download and verify SHA-256 checksum before extracting
RUN set -eux; \
    ARCH=$(dpkg --print-architecture); \
    GITLEAKS_VERSION=8.18.4; \
    TARBALL="gitleaks_${GITLEAKS_VERSION}_linux_${ARCH}.tar.gz"; \
    curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${TARBALL}" \
         -o /tmp/gitleaks.tar.gz; \
    curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_checksums.txt" \
         -o /tmp/gitleaks_checksums.txt; \
    grep "${TARBALL}" /tmp/gitleaks_checksums.txt | sha256sum -c -; \
    tar -xz -C /usr/local/bin -f /tmp/gitleaks.tar.gz gitleaks; \
    rm /tmp/gitleaks.tar.gz /tmp/gitleaks_checksums.txt

WORKDIR /app
# Copy pre-built node_modules from host; overwrite the @lap/managed-tools symlink
# with the real directory so Node can resolve it at runtime.
COPY harnesses/claude-agent-sdk/package.json ./
COPY harnesses/claude-agent-sdk/node_modules/ ./node_modules/
COPY managed-tools/ ./node_modules/@lap/managed-tools/

# Install platform-native claude binary (npm install for just this one package avoids
# the file: dep resolution bug that affects full npm install).
RUN arch=$(uname -m) && \
    if [ "$arch" = "aarch64" ]; then \
      npm install @anthropic-ai/claude-agent-sdk-linux-arm64 --no-save --legacy-peer-deps; \
    else \
      npm install @anthropic-ai/claude-agent-sdk-linux-x64 --no-save --legacy-peer-deps; \
    fi

COPY harnesses/claude-agent-sdk/dist/ ./dist/

# Run as non-root — claude's --dangerously-skip-permissions (bypassPermissions) is
# blocked when running as root/sudo for security reasons.
RUN useradd -m -u 1001 agent
USER agent
WORKDIR /home/agent
# Re-copy app files with correct ownership
RUN cp -r /app/node_modules ./node_modules && cp -r /app/dist ./dist && cp /app/package.json .

ENV PORT=4096
EXPOSE 4096

# Entrypoint writes ~/.claude/settings.json from runtime env vars.
RUN printf '#!/bin/sh\nmkdir -p ~/.claude\nprintf '"'"'{"env":{"ANTHROPIC_BASE_URL":"%s","ANTHROPIC_AUTH_TOKEN":"%s","ANTHROPIC_API_KEY":"%s"}}'"'"' \\\n  "${LITELLM_API_BASE%%/}" "${LITELLM_API_KEY}" "${LITELLM_API_KEY}" \\\n  > ~/.claude/settings.json\nexec node /home/agent/dist/server.js\n' > /home/agent/entrypoint.sh && chmod +x /home/agent/entrypoint.sh

CMD ["/home/agent/entrypoint.sh"]

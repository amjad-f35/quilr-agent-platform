# E2B sandbox template for LiteLLM dev work.
# Mirrors the litellm-4gb spec (4 GB RAM / 8 vCPU set at build time).
#
# Pre-baked so "stand up the proxy" is one command, not a 15-min yak shave:
#   - All litellm[proxy] deps installed (pip install -e ".[proxy]" done at build time)
#   - Global pip.conf pointing at pypi.org — no --trusted-host gymnastics
#   - uv installed via pip (not the curl/astral installer) so uv_build resolves cleanly
#   - PostgreSQL cluster owned by `user`, dev db pre-created
#   - /usr/local/bin/dev-up: starts postgres + exports env vars; `source dev-up` = ready
FROM e2bdev/code-interpreter:latest

USER root

# ── System packages ────────────────────────────────────────────────────────────
# postgresql: dev db; lib*-dev + build-essential: compiled proxy deps
# (PyNaCl→libsodium, psycopg2→libpq, cryptography→libssl/libffi)
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates \
      postgresql postgresql-client \
      libpq-dev libsodium-dev libssl-dev libffi-dev \
      python3-dev build-essential pkg-config \
 && rm -rf /var/lib/apt/lists/*

# ── CA bundle ──────────────────────────────────────────────────────────────────
# Trust cloud-vault CA so HTTPS_PROXY TLS MITM succeeds in sandboxes.
# E2B may reset /etc/ssl/certs at container startup; combined-ca.crt survives
# because all tooling is pointed at it via ENV (not /etc/ssl/certs/ca-certs.crt).
COPY cloud-vault-ca.crt /etc/cloud-vault-ca.crt
RUN cat /etc/ssl/certs/ca-certificates.crt /etc/cloud-vault-ca.crt \
      > /etc/ssl/certs/combined-ca.crt

ENV SSL_CERT_FILE=/etc/ssl/certs/combined-ca.crt
ENV CURL_CA_BUNDLE=/etc/ssl/certs/combined-ca.crt
ENV GIT_SSL_CAINFO=/etc/ssl/certs/combined-ca.crt
ENV NODE_EXTRA_CA_CERTS=/etc/cloud-vault-ca.crt
ENV REQUESTS_CA_BUNDLE=/etc/ssl/certs/combined-ca.crt
ENV PIP_CERT=/etc/ssl/certs/combined-ca.crt
ENV UV_NATIVE_TLS=true

# ── pip config ─────────────────────────────────────────────────────────────────
# System-wide pip.conf: always use pypi.org, always trust it, always use combined cert.
# Eliminates the per-install --index-url / --trusted-host / --cert flag parade.
# Both /etc/pip.conf (root) and ~/.pip/pip.conf (user) are set; pip checks both.
RUN printf '[global]\nindex-url = https://pypi.org/simple\ntrusted-host = pypi.org\ncert = /etc/ssl/certs/combined-ca.crt\n' \
      > /etc/pip.conf \
 && mkdir -p /home/user/.pip \
 && cp /etc/pip.conf /home/user/.pip/pip.conf \
 && chown -R user:user /home/user/.pip

# ENV fallbacks so subprocesses that bypass pip.conf also get the right index.
ENV PIP_INDEX_URL=https://pypi.org/simple
ENV PIP_TRUSTED_HOST=pypi.org
# uv: point at pypi.org (UV_DEFAULT_INDEX = uv ≥0.4; UV_INDEX_URL = older)
ENV UV_DEFAULT_INDEX=https://pypi.org/simple
ENV UV_INDEX_URL=https://pypi.org/simple

# ── uv ────────────────────────────────────────────────────────────────────────
# Install via pip (not the curl/astral install script) so it inherits pip.conf
# and the uv_build wheel resolves without --trusted-host gymnastics.
RUN pip install --no-cache-dir uv

# ── Clone repos ───────────────────────────────────────────────────────────────
RUN git clone --depth 1 https://github.com/BerriAI/litellm.git /home/user/litellm \
 && git clone --depth 1 https://github.com/BerriAI/litellm-docs.git /home/user/litellm-docs

# ── Pre-install proxy deps ─────────────────────────────────────────────────────
# Done at image-build time so agents never wait for a 200-package install.
# Editable install (-e) means git-pull/branch-switch reflects live without reinstall.
# Prisma binary is also downloaded here via post-install hook.
RUN cd /home/user/litellm \
 && pip install --no-cache-dir -e ".[proxy]"

# ── PostgreSQL dev cluster ────────────────────────────────────────────────────
# Cluster owned by `user` (not the postgres system account) so dev-up.sh can
# start/stop it without sudo inside the sandbox.
# pg_hba.conf default: Unix socket = trust, TCP = md5.
# litellm connects via TCP as role `litellm` with password `litellm`.
# unix_socket_directories is set to /tmp: the default /var/run/postgresql is
# root-owned (and a tmpfs that resets at sandbox runtime), so a `user`-run
# server can't create its socket lock there. /tmp is writable at build and run.
RUN set -e; \
    PG_VERSION=$(ls /usr/lib/postgresql | sort -V | tail -1); \
    PG_BIN="/usr/lib/postgresql/${PG_VERSION}/bin"; \
    PG_DATA="/home/user/pgdata"; \
    su -c "${PG_BIN}/initdb -D ${PG_DATA}" user; \
    su -c "echo \"unix_socket_directories = '/tmp'\" >> ${PG_DATA}/postgresql.conf" user; \
    su -c "${PG_BIN}/pg_ctl -D ${PG_DATA} start -w -t 30" user; \
    su -c "psql -h /tmp -d postgres -c \"CREATE USER litellm WITH PASSWORD 'litellm';\"" user; \
    su -c "psql -h /tmp -d postgres -c \"CREATE DATABASE litellm OWNER litellm;\"" user; \
    su -c "${PG_BIN}/pg_ctl -D ${PG_DATA} stop -m fast" user

# ── Dev DB + proxy env (baked in) ──────────────────────────────────────────────
# E2B runs each `commands.run` in a fresh, non-interactive shell, so env from
# `source dev-up` never carries across commands. Baking these as image ENV makes
# DATABASE_URL (and the proxy creds) available to EVERY command automatically.
# Postgres itself is auto-started by the template start_cmd (see e2b.toml).
ENV DATABASE_URL=postgresql://litellm:litellm@localhost:5432/litellm
ENV LITELLM_MASTER_KEY=sk-1234
ENV LITELLM_SALT_KEY=sk-litellm-salt-dev-unsafe
ENV STORE_MODEL_IN_DB=True

# ── DB start + dev-up scripts ──────────────────────────────────────────────────
# start-db: starts postgres (run at sandbox boot via e2b.toml start_cmd).
# dev-up:   source it for an interactive shell → starts postgres + exports env.
COPY start-db.sh /usr/local/bin/start-db
COPY dev-up.sh /usr/local/bin/dev-up
RUN chmod +x /usr/local/bin/start-db /usr/local/bin/dev-up

RUN chown -R user:user /home/user/litellm /home/user/litellm-docs

# Drop back to `user` (we switched to root on line 12). The sandbox runs as
# `user`, and postgres' pg_ctl refuses to run as root — so the start_cmd needs
# this to be the image's default user.
USER user

# E2B sandbox template

The agent sandboxes (E2B `provision`/`execute` tools) run on an E2B template.
This is its source so it lives in version control instead of only on someone's
laptop.

`E2B_TEMPLATE` (see `src/server/env.ts`) selects which template the platform
uses when it spins up a sandbox.

## What's in it
- Base: `e2bdev/code-interpreter` (Python + Node + Jupyter).
- **Pre-cloned repos** (no per-session clone):
  - `https://github.com/BerriAI/litellm` → `/home/user/litellm`
  - `https://github.com/BerriAI/litellm-docs` → `/home/user/litellm-docs`
- **All `litellm[proxy]` deps pre-installed** — no per-session install wait.
- **Global pip.conf** always points at `https://pypi.org/simple` with the combined CA cert — no `--trusted-host` / `--index-url` flags ever needed.
- **`uv` pre-installed** via pip (not the curl/astral installer) so `uv_build` resolves cleanly.
- **PostgreSQL cluster** owned by `user` at `/home/user/pgdata`, dev db `litellm` pre-created — **auto-started on sandbox boot** (`start_cmd` in `e2b.toml`).
- **`DATABASE_URL` (and proxy creds) baked in as image `ENV`** — available to every command, no setup step. E2B runs each command in a fresh shell, so `source dev-up` exports wouldn't carry across commands; image `ENV` does.
- **`/usr/local/bin/dev-up`**: convenience for an interactive shell (starts postgres + echoes env).

Both repos are public, so no token is baked into the image.

## Standing up the proxy (from inside a sandbox)

One command — starts postgres + the proxy on a **free** port and only returns
once `/health/readiness` is 200 (or exits non-zero with log + OOM diagnostics):

```bash
litellm-status      # JSON: ready|provisioning|down|oom — call this first
litellm-up          # if not ready: free port + proxy (--use_prisma_db_push), blocks until ready
                    # prints {"port":N,"master_key":"sk-1234","url":"…"} — never hardcode 4000
```

`litellm-up` uses `--use_prisma_db_push` (≈0.6 s) instead of `migrate deploy`
(~20 min across 124 migrations). **playwright + chromium** are pre-installed
(`PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright`) for in-sandbox UI screenshots.

`prisma` is pre-installed and its engines/client are pre-fetched at build, so
there's no ~150 MiB first-boot download. Postgres + `DATABASE_URL` are
pre-provisioned. The pre-cloned repo's branch/commit are recorded in
`/home/user/litellm/AGENTS.md` — use that checkout, don't re-clone.

Manual alternative (if you need flags): `source /usr/local/bin/dev-up` then
`cd ~/litellm && python -m litellm.proxy.proxy_cli --config /tmp/litellm_config.yaml --port <free-port>`.

Dev credentials baked into the image as `ENV` (and echoed by `dev-up`):

| Var | Value |
|-----|-------|
| `DATABASE_URL` | `postgresql://litellm:litellm@localhost:5432/litellm` |
| `LITELLM_MASTER_KEY` | `sk-1234` |
| `LITELLM_SALT_KEY` | `sk-litellm-salt-dev-unsafe` |
| `STORE_MODEL_IN_DB` | `True` |

> These are throwaway dev-only values (same ones `dev-up` has always exported),
> baked as image `ENV` so they're readable via `docker inspect` / `docker history`.
> Keep this template **private** — never push the built image to a public
> registry. The E2B template itself is private to the owning team.

## Build / update
Requires E2B CLI auth (`e2b auth login`) for the team that owns the template.

```bash
cd e2b
e2b template build --name litellm-4gb --cpu-count 8 --memory-mb 4096
```

`--cpu-count 8 --memory-mb 4096` matches the 4 GB spec. After it builds, set
`E2B_TEMPLATE` (and `E2B_API_KEY` for the owning team) on the platform service.

To refresh the pinned repo contents, rebuild with `--no-cache`.
```

# Running a local instance

This is a self-contained LianRouter checkout: one process, one PostgreSQL
database, its own `.env`, and its own console password. Everything below is
about running it on a single machine or a LAN — the shape the repository is set
up for by default.

## What "local" means here

- The gateway listens on loopback and, if you choose, your LAN. It is reachable
  from other machines only when you expose it deliberately — a tunnel, a reverse
  proxy, or a public base URL. See **Share access and tunnels** in
  [README.md](README.md).
- Console auth is a single password, `LIANROUTER_CONSOLE_PASSWORD`, settable
  from `.env` and changeable afterwards from Settings → Security Controls.
- PostgreSQL is external to the process. The default development setup points
  `DATABASE_URL` at a local server; nothing here provisions a database for you.
- Redis is optional when `REDIS_MODE=single_instance_local`, which is the
  simplest configuration for one machine.

## Running it

```bash
bun install
bun install --cwd dashboard
bun run setup          # schema + provider catalog
bun run dev            # http://localhost:12800/console
```

The console listens on `12800` by default. When a second instance is already
using that port, run this one on `12810` instead — `--port 12810` on the
launcher, or the matching `PORT` value in `.env` — so both can coexist on one
machine without a bind conflict.

## Deploying

This checkout is self-contained and has no deploy pipeline. Putting it anywhere
— another machine, a container host, a public server — is a separate,
deliberate act you perform yourself, with that deployment's own `.env`,
database, and release cadence. Nothing in this repository publishes, uploads, or
synchronises an instance on its own.

## Tests

```bash
bun run typecheck
bun run test
bun run dashboard:typecheck
bun run dashboard:test
```

Database-gated suites run when `LIANROUTER_TEST_DATABASE_URL` points at an
isolated database; otherwise they skip and report the reason.

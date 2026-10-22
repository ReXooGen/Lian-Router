# Local-only build

This folder is the **local, self-hosted** working copy of LianRouter. It is a
separate project from the server-side deployment on the VPS, with its own git
history, `.env`, database, and release cadence.

## Why two projects

The hosted instance and this one have different constraints:

| | This project (`Cartethyia-local`) | Server project (`Cartethyia-dev`) |
| --- | --- | --- |
| Reachability | loopback / LAN, optionally tunnelled | public host behind nginx |
| Console auth | single password, changeable from the console | per-user accounts |
| Share / enrollment | exposed through a tunnel with a public base URL | internal use |
| Deploy target | `bun run dev` on this machine | systemd service + compiled binary |

Keeping them apart means a change made while working on the local experience
cannot be shipped to the server by accident, and the server's release process
never drags local experiments along.

## Rules for this project

- Nothing here is deployed to the VPS. Deploying is a deliberate, separate act
  performed in the server project.
- `.env` is local and never committed. `DATABASE_URL` points at the local
  PostgreSQL on `127.0.0.1:55432`.
- The console listens on port `12800` by default. This project's dev runs use
  `12810` when the server project is also running, so both can coexist.

## Running it

```bash
bun install
bun install --cwd dashboard
bun run setup          # schema + provider catalog
bun run dev            # http://localhost:12800/console
```

Exposing it to other people (tunnel, public base URL, trusted proxy) is covered
in the README under **Share access and tunnels**.

## Tests

```bash
bun run typecheck
bun run test
bun run dashboard:typecheck
bun run dashboard:test
```

Database-gated suites run when `LIANROUTER_TEST_DATABASE_URL` points at an
isolated database; otherwise they skip and report the reason.

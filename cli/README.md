# lianrouter

The LianRouter launcher. One command starts the gateway, opens its console,
keeps it running in the background, and updates it — without cloning the
repository.

LianRouter is a multi-provider gateway for OpenAI-compatible chat, embedding, and
image APIs: one local endpoint, many upstream providers, with routing, keys,
usage accounting, and an admin console. This package is only the **launcher**.
The gateway itself is a separate compiled binary that this package installs on
first run.

## Install

```bash
bun add -g lianrouter
# or
npm i -g lianrouter
```

The bin runs under the Bun runtime and declares `engines.bun`, so Bun must be on
`PATH` whichever package manager put the launcher there.

## First run

```bash
lianrouter
```

The launcher does **not** download anything during `bun add -g` / `npm i -g` —
an install that reaches the network breaks offline and CI installs. Instead, the
first `lianrouter` run finds no gateway in the install root, fetches the release
archive for your platform, verifies its sha256, and installs it atomically,
showing progress while it downloads:

```text
gateway not installed; fetching the latest release
  downloading  42%  19.2 MB / 44.7 MB
  verifying    78%  checksum ok (sha256 0123456789ab…)
  installing   90%  installed lianrouter.exe
Gateway 2.0.0 installed at ~/.local/share/LianRouter/lianrouter
```

An archive without a published digest is refused rather than installed, and a
platform with no published build is told so by name instead of failing later at
spawn. Every subsequent run finds the binary and starts offline.

Installing the gateway is not the same as configuring it: the gateway still needs
`DATABASE_URL` (and `REDIS_URL` when `REDIS_MODE=normal`) in its environment or a
`.env` in its working directory before `/health` can answer. See
[`README.md`](https://github.com/ReXooGen/Lian-Router/blob/main/README.md) for the
variable list; a startup failure prints the gateway's own error line.

## Use

With no arguments, `lianrouter` starts the gateway and opens the menu — Web UI,
Terminal UI, Hide to Tray, Exit. Subcommands skip the menu:

```bash
lianrouter start          # start in the foreground, then the menu
lianrouter status         # print state and exit
lianrouter stop           # stop the supervised gateway
lianrouter update         # check, install, restart
lianrouter tray           # background gateway with a tray icon (Windows)
lianrouter tui            # terminal console
lianrouter --version
lianrouter --help
```

`status` and `stop` never install anything: they answer a question about the
current machine and must work offline. `--port`, `--host`, `--no-open`, and
`--background` cover the rest.

## Where things live

The gateway binary, `migrations/`, the console assets, the pid file, the log, and
the update cache all live under one install root:

| Platform | Root |
|---|---|
| Windows | `%LOCALAPPDATA%\LianRouter` |
| macOS | `~/Library/Application Support/LianRouter` |
| Linux | `$XDG_DATA_HOME/LianRouter`, else `~/.local/share/LianRouter` |

`LIANROUTER_HOME` relocates the whole layout. The gateway logs to
`<root>/logs/lianrouter.log`.

## Documentation

[`cli/CLI.md`](https://github.com/ReXooGen/Lian-Router/blob/main/cli/CLI.md)
covers the install root, the process model, the loopback control plane, the
update flow, the tray, and the TUI. Product documentation for the gateway itself
lives in the [repository](https://github.com/ReXooGen/Lian-Router).

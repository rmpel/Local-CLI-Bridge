# CLI Bridge — control Local sites from the command line.

A [Local](https://localwp.com) addon (Local 9+) that exposes site control on the
command line through a `local-cli` command: list, start, stop and restart sites
from a shell script, a cron job or a CI runner.

It is a drop-in replacement for the deprecated `@getflywheel/local-cli`, which
talks to Local's GraphQL server and can no longer be relied upon. Same command
names (`list-sites`, `start-site`, `stop-site`), same table layout, so scripts
written against the old tool keep working. CLI Bridge does not use GraphQL at
all: it runs a tiny HTTP server on a Unix domain socket inside Local's own main
process and drives Local's site process manager directly.

## LICENSING

Copyright (C) 2026 Remon Pel.

This software is released under the GNU General Public License v3.0 (or, at
your option, any later version). The full license text is in the [LICENSE](LICENSE)
file that ships with every copy.

This means:

- You can use it however you like for both personal and business projects.
- If you modify and distribute your own version, you must share your source code under this exact same license.
- You cannot strip my name or copyright notice; proper attribution must always remain.
- While the license technically allows distribution, any copies must remain fully open-source, ensuring it stays free for everyone forever.

## Changelog

Can be found in [CHANGELOG.md](CHANGELOG.md)

## Co-authored by Claude, Fable 5

This project is written by myself and Claude, Fable 5, and tested by myself on local hardware in LocalWP 10. The API in v9 is identical, so it should work, but please feel free to either confirm or deny this claim.

## NO LIABILITY!!!!

Use at your own risk!!!!

Just because it works for me, does not mean it will work for you!

Feel free to burn it down!

I welcome every comment, positive as well as negative. (I might get cranky, but eventually I'll cave and fix it)

Feel free to contribute!

## Usage

```
local-cli list-sites
local-cli site-status  my-site.local
local-cli start-site   my-site.local
local-cli stop-site    my-site.local
local-cli restart-site my-site.local
local-cli ping
```

A site can be referenced by its ID, its domain or its name (case-insensitive).
A unique prefix of the name or domain works too; an ambiguous prefix lists the
candidates and fails.

`list-sites` prints the same `ID | Name | Status` table the old local-cli did:

```
┌───────────┬────────┬─────────┐
│ ID        │ Name   │ Status  │
├───────────┼────────┼─────────┤
│ EE0cNsiD3 │ wp     │ running │
├───────────┼────────┼─────────┤
│ B89vv25eL │ mysite │ halted  │
└───────────┴────────┴─────────┘
```

Add `--json` for the raw response (ideal for `jq`) or `--plain` for
tab-separated `ID  Name  Domain  Status` (ideal for `cut`/`awk`):

```
$ local-cli list-sites --plain
EE0cNsiD3	wp	wp.local	running
B89vv25eL	mysite	mysite.test	halted

$ local-cli start-site mysite --json
{ "id": "B89vv25eL", "name": "mysite", "status": "running", "action": "start", "changed": true, ... }
```

Starting an already running site or stopping an already stopped site is a
successful no-op (`changed: false`). Start/stop/restart return once Local
reports the transition finished, typically within a few seconds.

Exit codes: `0` ok, `1` the command failed (unknown site, Local refused to
start it, …), `2` Local or the add-on is not reachable, `64` usage error.

## How it works

- On launch the add-on listens on `~/.local-cli-bridge/bridge.sock` (a named
  pipe on Windows). The directory and socket are mode 0700/0600, so only the user
  running Local can talk to it. No token, no TCP port.
- `~/.local-cli-bridge/bridge.json` records the socket path, Local's pid and
  version; the CLI reads it to find the socket. Both are removed when Local quits.
- `bin/local-cli` is a plain POSIX shell script that needs nothing but `curl`.
  It deliberately does not use Node: the deprecated tool broke whenever a shell
  had switched to another Node (nvm, an `.nvmrc` in the current directory, a
  containerised runtime), and this one cannot. All formatting happens inside the
  bridge; the script only maps the HTTP status to an exit code.
- The bridge's small API (`Accept: text/plain` or `format=table|plain|json`
  selects the output; the site can be a path segment or a `site` parameter):

  | Method | Path                      | Description                          |
  | ------ | ------------------------- | ------------------------------------ |
  | GET    | `/ping`                   | Versions and pid                     |
  | GET    | `/sites`                  | All sites with status                |
  | GET    | `/sites/{ref}`            | One site (also `/site?site={ref}`)   |
  | POST   | `/sites/{ref}/start`      | Start; no-op when running            |
  | POST   | `/sites/{ref}/stop`       | Stop; no-op when halted              |
  | POST   | `/sites/{ref}/restart`    | Restart                              |

  You can call it with curl directly as well:
  `curl --unix-socket ~/.local-cli-bridge/bridge.sock -X POST http://local/sites/wp/start`

- Start/stop/restart go through Local's own `siteProcessManager`, exactly the
  code path the Start/Stop buttons in the UI use, and the command returns when
  Local reports the transition finished.
- Adding a command later means one route in `src/server.ts` (plus its text
  rendering in `src/format.ts`) and one line in the command `case` of
  `bin/local-cli`.

## Installing

- Clone repo
- Shut down Local
- run `./scripts/install.sh` (links the add-on into Local and `local-cli` into
  `/usr/local/bin` when writable, else `~/.local/bin`; use `--bin-dir <dir>` to choose)
- If you still have the deprecated npm package installed it usually comes first on
  your PATH and shadows this command; the installer warns about it. Remove it with
  `npm uninstall -g @getflywheel/local-cli`.
- Start Local
- Enable the "CLI Bridge" add-on under Add-ons → Installed
- Restart Local when so asked
- `local-cli ping`

`./scripts/uninstall.sh` reverses this. `./scripts/build.sh` produces a `.tgz`
for "Install from disk".

## Compatibility

- `engines.local-by-flywheel: >=9.0.0` — uses only `siteData`,
  `siteProcessManager` and `localLogger` from Local's service container, which
  are identical in Local 9 and 10 (tested on 10.1.2).

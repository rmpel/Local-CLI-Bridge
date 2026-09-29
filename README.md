# CLI Bridge — control Local sites from the command line.

A [Local](https://localwp.com) addon (Local 9+) that exposes site control on the
command line through a `local-cli` command: list, start, stop, restart, create
and reconfigure sites, and open their admin, Mailpit or database manager, from a
shell script, a cron job or a CI runner.

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

local-cli add-site "My Site" [--domain=my-site.test] [--multisite=subdir|subdomain]
                   [--php=8.3] [--mysql=8.4 | --mariadb=10.11] [--apache | --nginx]
                   [--admin-user=admin --admin-password=admin --admin-email=me@example.com]
                   [--no-wait]
local-cli change-site my-site php 8.3
local-cli change-site my-site mysql 8.4
local-cli change-site my-site apache
local-cli change-site my-site multisite subdomain [--dry-run]
local-cli services [php|db|http]

local-cli open    my-site [--url] [--start]
local-cli admin   my-site [--auto-login] [--url] [--start]
local-cli db      my-site            (alias: adminneo)
local-cli mailpit my-site [--url] [--start]
```

A site can be referenced by its ID, its domain or its name (case-insensitive).
A unique prefix of the name or domain works too; an ambiguous prefix lists the
candidates and fails. When the site argument is omitted, `$LOCAL_SITE_ID` and
then `$LOCAL_SITE_NAME` are used, so a site's own shell can say `local-cli admin`.

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

### add-site

Does what Local's "Add Site" dialog does, with the dialog's defaults:

- The name is slugified the way Local does it (`"My Site"` → `my-site`), the
  domain is the slug plus the default TLD from Local's preferences, and the
  folder is the slug inside the default sites path. `--domain` overrides the
  domain only.
- No service flags means Local's "Preferred" environment: Local picks its own
  preferred PHP, database and web server (nginx). Any of `--php`, `--mysql`,
  `--mariadb`, `--apache`, `--nginx` switches to a "Custom" environment; Local
  fills in the services you did not name.
- A version can be exact (`8.3.30`) or `major.minor` (`8.3`), which resolves
  to the newest matching release Local knows, downloaded when it is not
  installed yet. `local-cli services` lists what is available. A bare
  `--apache`/`--nginx` takes the newest installed version.
- WordPress is installed with default content and the language from Local's
  preferences. Credentials default to `admin` / `admin` and the default admin
  email from Local's preferences; the reply repeats them.
- The command waits until WordPress is installed (typically 30 to 90 seconds),
  or returns as soon as Local has registered the site with `--no-wait`.
- A subdomain network is refused while Local's router runs in localhost mode,
  as in the dialog.

### change-site

`php`, `mysql`, `mariadb`, `apache` and `nginx` go through Local's own service
swapper, the same code as the "Custom" environment picker on the site's
Overview tab: download if needed, stop, re-template, start, flush permalinks.
Local shows the result in its window; when a swap fails Local shows an error
dialog, reverts the site and the command fails.

`multisite subdir|subdomain` converts a single site into a network with
`wp core multisite-convert`, or switches an existing network between
subdirectory and subdomain addressing. A switch rewrites every sub-site's
address (`example.test/blog/` ⇄ `blog.example.test/`) and refuses, changing
nothing, when a sub-site's address cannot be derived from the network domain
(a mapped domain, a nested path). `--dry-run` shows the plan. Afterwards the
mode is recorded on the site, sub-site domains are synced to the hosts file,
and the site restarts. Sites on Apache get WordPress's own network rewrite
rules written to `.htaccess` (created, or replacing the standard WordPress
block; a hand-written file is left alone and the rules are printed). nginx
sites get them from Local's template. Turning a network back into a single
site is deliberately not offered.

### open, admin, db, mailpit

Open the site, `wp-admin`, the bundled AdminNeo database manager or Mailpit
in the browser Local is configured to use (Preferences → Default apps). The
site must be running; `--start` starts it first. `--url` prints the URL
instead of opening it (not available for `db`, whose port is chosen when it
opens). `admin --auto-login` appends Local's One-click admin login for the
user chosen on the site's Overview tab, or the first administrator when none
is chosen.

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

  | Method | Path                      | Description                                                        |
  | ------ | ------------------------- | ------------------------------------------------------------------ |
  | GET    | `/ping`                   | Versions and pid                                                   |
  | GET    | `/sites`                  | All sites with status                                              |
  | POST   | `/sites`                  | Create a site (`name`, `domain`, `multisite`, `php`, `mysql`, …)   |
  | GET    | `/services`               | Available service versions (`role=php\|db\|http`)                   |
  | GET    | `/sites/{ref}`            | One site (also `/site?site={ref}`)                                 |
  | POST   | `/sites/{ref}/start`      | Start; no-op when running                                          |
  | POST   | `/sites/{ref}/stop`       | Stop; no-op when halted                                            |
  | POST   | `/sites/{ref}/restart`    | Restart                                                            |
  | POST   | `/sites/{ref}/change`     | `op=php\|mysql\|mariadb\|apache\|nginx\|multisite`, `value=…`, `dry-run=1` |
  | POST   | `/sites/{ref}/open`       | `target=site\|admin\|mailpit\|db`, `auto-login=1`, `url=1`, `start=1`  |

  You can call it with curl directly as well:
  `curl --unix-socket ~/.local-cli-bridge/bridge.sock -X POST http://local/sites/wp/start`

- Start/stop/restart go through Local's own `siteProcessManager`, exactly the
  code path the Start/Stop buttons in the UI use, and the command returns when
  Local reports the transition finished. Likewise `add-site` calls Local's
  `addSite` service, service swaps call `siteProvisioner.swapService`, the
  database manager is Local's `adminer` service and URLs open through Local's
  `browserManager`. WordPress work (multisite conversion, admin lookup) runs
  through Local's bundled WP-CLI (`wpCli` service), using the site's own PHP.
- The multisite helpers in `php/` are run with `wp eval-file`:
  `network-htaccess.php` asks WordPress core (`network_step2()`) for the
  network's Apache rules, `network-switch.php` rewrites sub-sites between
  subdirectory and subdomain addressing.
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

- `engines.local-by-flywheel: >=9.0.0` — uses `siteData`, `siteProcessManager`,
  `addSite`, `siteProvisioner`, `lightningServices`, `adminer`, `browserManager`,
  `wpCli`, `multiSite` and `localLogger` from Local's service container, all
  present with the same signatures in the Local 9 typings (tested on 10.1.2).
- The bundled database manager is AdminNeo in Local 10 (Adminer in Local 9);
  `local-cli db` opens whichever Local ships.

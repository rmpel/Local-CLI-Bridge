# Changelog for LocalWP Plugin "CLI Bridge"

= 1.1.0 =

- Released 2026-09-29.
- `add-site <name>`: creates a site exactly like Local's "Add Site" dialog (same name-to-domain and path derivation, Local's preferred services unless `--php`, `--mysql`/`--mariadb`, `--apache`/`--nginx` are given, `--multisite=subdir|subdomain`, `--domain`, WordPress admin credentials via `--admin-user`/`--admin-password`/`--admin-email`, `--no-wait`). A `major.minor` version resolves to the newest matching release, downloaded when needed.
- `change-site <site> php|mysql|mariadb|apache|nginx [version]`: swaps a service through Local's own service swapper (the "Custom" environment picker).
- `change-site <site> multisite subdir|subdomain [--dry-run]`: turns a single site into a network (`wp core multisite-convert`) or switches a network between subdirectory and subdomain addressing, rewriting the sub-sites. Apache sites get WordPress's own network rewrite rules in `.htaccess`, taken from WordPress core at runtime with a static fallback. Refuses when a sub-site uses a mapped domain, and never downgrades a network to a single site.
- `open`, `admin [--auto-login]`, `db`/`adminneo`, `mailpit`: open the site, wp-admin (with Local's One-click admin login), the bundled AdminNeo database manager or Mailpit in the browser Local is configured to use; `--url` prints the URL instead, `--start` starts a halted site first.
- `services [php|db|http]`: lists the service versions Local can use, installed or downloadable.
- Every command taking a site falls back to `$LOCAL_SITE_ID`, then `$LOCAL_SITE_NAME`, when the site argument is omitted.
- Bridge API: `POST /sites`, `GET /services`, `POST /sites/{ref}/change`, `POST /sites/{ref}/open`; site summaries now carry a `multisite` field.
- The shell client now works on the bash 3.2 that ships with macOS when no options are given (an empty-array bug under `set -u`).

= 1.0.0 =

- Released 2026-09-25 under GPLv3, see LICENSE for details.
- First release: a drop-in `local-cli` with `list-sites`, `site-status`, `start-site`, `stop-site`, `restart-site` and `ping`, served by a Unix-socket HTTP bridge inside Local's main process. The client is a curl-only POSIX shell script, so nvm/.nvmrc Node switching cannot break it. Replaces the deprecated GraphQL-based `local-cli` for these tasks.

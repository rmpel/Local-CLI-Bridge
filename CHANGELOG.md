# Changelog for LocalWP Plugin "CLI Bridge"

= 1.0.0 =

- Released 2026-09-25 under GPLv3, see LICENSE for details.
- First release: a drop-in `local-cli` with `list-sites`, `site-status`, `start-site`, `stop-site`, `restart-site` and `ping`, served by a Unix-socket HTTP bridge inside Local's main process. The client is a curl-only POSIX shell script, so nvm/.nvmrc Node switching cannot break it. Replaces the deprecated GraphQL-based `local-cli` for these tasks.

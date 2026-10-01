/**
 * Output rendering lives in the bridge (Local's main process) rather than in
 * the client, so the client can be a dependency-free shell script that only
 * needs curl. That keeps it immune to whatever `node` is active in the shell
 * (nvm switches, .nvmrc files, containerised runtimes).
 */
import type { AddSiteResult, ChangeServiceResult, MultisiteReply, OpenResult, ServiceRow, SiteSummary, SslStatus, TrustResult } from './server';

export type Format = 'json' | 'table' | 'plain';

export const CONTENT_TYPES: Record<Format, string> = {
	json: 'application/json',
	table: 'text/plain; charset=utf-8',
	plain: 'text/plain; charset=utf-8',
};

interface Column {
	key: string;
	label: string;
}

// The deprecated local-cli printed exactly ID | Name | Status, with a rule
// between every row (cli-table). Scripts parse that, e.g. "the 6th word of
// the matching row is the status", so the table keeps that exact shape.
const TABLE_COLUMNS: Column[] = [
	{ key: 'id', label: 'ID' },
	{ key: 'name', label: 'Name' },
	{ key: 'status', label: 'Status' },
];

// --plain adds the domain: tab-separated, no borders, for cut/awk.
const PLAIN_COLUMNS: Column[] = [
	{ key: 'id', label: 'ID' },
	{ key: 'name', label: 'Name' },
	{ key: 'domain', label: 'Domain' },
	{ key: 'status', label: 'Status' },
];

const SERVICE_COLUMNS: Column[] = [
	{ key: 'role', label: 'Role' },
	{ key: 'name', label: 'Service' },
	{ key: 'version', label: 'Version' },
	{ key: 'installed', label: 'Installed' },
];

const renderTable = (rows: object[], columns: Column[], plain: boolean): string => {
	const cells = rows.map((row) => columns.map((col) => String(row[col.key] ?? '')));
	if (plain) {
		return cells.map((row) => row.join('\t')).join('\n');
	}
	const header = columns.map((col) => col.label);
	const widths = header.map((label, i) => Math.max(label.length, ...cells.map((row) => row[i].length)));
	const line = (l: string, m: string, r: string) => l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r;
	const render = (row: string[]) => '│' + row.map((cell, i) => ` ${cell.padEnd(widths[i])} `).join('│') + '│';
	const out = [line('┌', '┬', '┐'), render(header)];
	for (const row of cells) {
		out.push(line('├', '┼', '┤'), render(row));
	}
	out.push(line('└', '┴', '┘'));
	return out.join('\n');
};

export const siteTable = (rows: SiteSummary[], format: Format): string =>
	rows.length ? renderTable(rows, format === 'plain' ? PLAIN_COLUMNS : TABLE_COLUMNS, format === 'plain') : 'No sites.';

export const candidateTable = (rows: object[], format: Format): string =>
	renderTable(rows, PLAIN_COLUMNS.slice(0, 3), format === 'plain');

export const pingText = (info: { localVersion: string; addonVersion: string; pid: number }, format: Format): string =>
	format === 'plain'
		? `ok\t${info.localVersion}\t${info.addonVersion}`
		: `Local ${info.localVersion} is running, CLI Bridge v${info.addonVersion} (pid ${info.pid}).`;

export const transitionText = (
	site: SiteSummary & { action: string; changed: boolean },
	format: Format,
): string => {
	if (format === 'plain') {
		return `${site.id}\t${site.name}\t${site.status}\t${site.changed ? 'changed' : 'unchanged'}`;
	}
	const verb = { start: 'started', stop: 'stopped', restart: 'restarted' }[site.action] ?? site.action;
	const note = site.changed ? verb : `already ${site.status}, nothing to do`;
	return `${site.name} (${site.id}): ${note}; status is now "${site.status}".`;
};

export const servicesText = (rows: ServiceRow[], format: Format): string =>
	rows.length
		? renderTable(rows.map((row) => ({ ...row, installed: row.installed ? 'yes' : 'download' })), SERVICE_COLUMNS, format === 'plain')
		: 'No services.';

const serviceLine = (site: SiteSummary): string => {
	const order = ['php', 'mysql', 'mariadb', 'nginx', 'apache'];
	return Object.entries(site.services)
		.sort(([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
		.filter(([key]) => key !== 'mailpit')
		.map(([, value]) => value)
		.join(', ');
};

const networkLabel = (mode: string): string => mode === 'subdir' ? 'subdirectory network' : mode === 'subdomain' ? 'subdomain network' : 'single site';

export const addSiteText = (site: AddSiteResult, format: Format): string => {
	if (format === 'plain') {
		return `${site.id}\t${site.name}\t${site.domain}\t${site.status}\t${site.pending ? 'pending' : 'ready'}`;
	}
	const lines = [
		site.pending
			? `Creating "${site.name}" (${site.id}); Local is still provisioning it, check with site-status.`
			: `Created "${site.name}" (${site.id}), status "${site.status}".`,
		`  URL:       ${site.url}`,
		`  Path:      ${site.path}`,
		`  Services:  ${serviceLine(site) || '(chosen by Local)'}`,
		`  WordPress: ${networkLabel(site.multisite)}; admin "${site.credentials.username}" / "${site.credentials.password}" (${site.credentials.email})`,
	];
	return lines.join('\n');
};

export const changeServiceText = (data: ChangeServiceResult, format: Format): string => {
	if (format === 'plain') {
		return `${data.id}\t${data.name}\t${data.status}\t${data.changed ? 'changed' : 'unchanged'}\t${data.to}`;
	}
	if (!data.changed) {
		return `${data.name} (${data.id}) already runs ${data.to}; nothing to do.`;
	}
	return `${data.name} (${data.id}): ${data.from} -> ${data.to}${data.downloaded ? ' (downloaded)' : ''}; status is now "${data.status}".`;
};

export const multisiteText = (data: MultisiteReply, format: Format): string => {
	if (format === 'plain') {
		return `${data.id}\t${data.name}\t${data.status}\t${data.changed ? 'changed' : data.dryRun ? 'dry-run' : 'unchanged'}\t${data.mode}`;
	}
	const head = data.dryRun
		? `Dry run for ${data.name} (${data.id}): ${networkLabel(data.previousMode)} -> ${networkLabel(data.mode)}. Nothing was changed.`
		: data.changed
			? `${data.name} (${data.id}): ${networkLabel(data.previousMode)} -> ${networkLabel(data.mode)}; status is now "${data.status}".`
			: `${data.name} (${data.id}) is already a ${networkLabel(data.mode)}; nothing to do.`;
	const lines = [head, ...data.steps.map((step) => `  - ${step}`)];
	if (data.plan.length) {
		lines.push('  Sub-sites:');
		for (const item of data.plan) {
			lines.push(`    ${item.blog_id}: ${item.from.domain}${item.from.path} -> ${item.to.domain}${item.to.path}`);
		}
	}
	if (data.rulesForManualUse) {
		lines.push('', 'Add these rules to .htaccess yourself, replacing the WordPress block:', '', data.rulesForManualUse.trimEnd());
	}
	return lines.join('\n');
};

export const sslText = (data: SslStatus & Partial<TrustResult>, format: Format): string => {
	const state = data.trusted ? 'trusted' : data.inKeychain ? 'in-keychain' : 'untrusted';
	if (format === 'plain') {
		return `${data.id}\t${data.name}\t${data.domain}\t${state}\t${data.certPath}`;
	}
	const who = `${data.name} (${data.id})`;
	let head: string;
	if (data.via === 'local' && data.pending) {
		head = `${who}: handed the certificate for ${data.domain} to Local's own Trust flow; it is not trusted yet. Finish what Local opened, then check with ssl-status.`;
	} else if (data.via && data.changed) {
		head = `${who}: the certificate for ${data.domain} is now trusted.`;
	} else if (data.via && data.trusted) {
		head = `${who}: the certificate for ${data.domain} was already trusted; nothing to do.`;
	} else if (data.trusted) {
		head = `${who}: the certificate for ${data.domain} is trusted.`;
	} else if (data.inKeychain) {
		head = `${who}: the certificate for ${data.domain} is in the System keychain but not trusted for SSL (a Trust from Local's window that macOS silently refused). Run: local-cli trust-ssl ${data.id}`;
	} else {
		head = `${who}: the certificate for ${data.domain} is not trusted. Run: local-cli trust-ssl ${data.id}`;
	}
	return [head, `  Certificate: ${data.certPath}`].join('\n');
};

export const openText = (data: OpenResult, format: Format): string => {
	if (!data.opened) {
		return data.openUrl;
	}
	if (format === 'plain') {
		return `${data.id}\t${data.name}\t${data.target}\t${data.openUrl}`;
	}
	const what = { site: 'site', admin: data.autoLogin ? 'WordPress admin (auto-login)' : 'WordPress admin', mailpit: 'Mailpit', db: 'database manager' }[data.target];
	return data.target === 'db'
		? `Opened the ${what} of ${data.name} (${data.id}) in your browser.`
		: `Opened the ${what} of ${data.name} (${data.id}): ${data.openUrl}`;
};

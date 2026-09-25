/**
 * Output rendering lives in the bridge (Local's main process) rather than in
 * the client, so the client can be a dependency-free shell script that only
 * needs curl. That keeps it immune to whatever `node` is active in the shell
 * (nvm switches, .nvmrc files, containerised runtimes).
 */
import type { SiteSummary } from './server';

export type Format = 'json' | 'table' | 'plain';

export const CONTENT_TYPES: Record<Format, string> = {
	json: 'application/json',
	table: 'text/plain; charset=utf-8',
	plain: 'text/plain; charset=utf-8',
};

interface Column {
	key: keyof SiteSummary;
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

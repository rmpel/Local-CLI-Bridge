import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as Local from '@getflywheel/local';
import { applyMultisiteBlock, HtaccessAction, NetworkType, STATIC_RULES, wrapMultisiteBlock } from './htaccess';

export type { NetworkType } from './htaccess';

/**
 * Turning a site into a network, or switching a network between
 * subdirectory and subdomain mode.
 *
 * Local itself only knows multisite at creation time (wp core
 * multisite-install) plus `multiSite.syncSubdomains()`, which pushes the
 * sub-site hostnames into the hosts file and reloads the router. Everything
 * else here goes through Local's bundled WP-CLI:
 *
 * - single -> network:     wp core multisite-convert [--subdomains]
 * - subdir <-> subdomain:  php/network-switch.php, then `wp config set`
 *
 * Afterwards the mode is stored on the site, Apache sites get WordPress's
 * own network rewrite rules in .htaccess (nginx sites get them from Local's
 * template on restart), sub-site domains are synced and the site restarts.
 * Downgrading a network to a single site is deliberately not offered.
 */

export type NetworkMode = '' | NetworkType;

export const MS_VALUES: Record<NetworkType, string> = { subdir: 'ms-subdir', subdomain: 'ms-subdomain' };

export const modeFromSite = (site: Local.Site): NetworkMode => {
	const value = (site as any).multiSite;
	return value === 'ms-subdir' ? 'subdir' : value === 'ms-subdomain' ? 'subdomain' : '';
};

/** Accepts the spellings a human types for `change-site … multisite <mode>`. */
export const parseNetworkTarget = (value: string): NetworkType | 'off' | null => {
	switch ((value ?? '').trim().toLowerCase()) {
		case 'subdir': case 'subdirectory': case 'subdirectories': case 'subfolder': case 'subfolders': case 'ms-subdir':
			return 'subdir';
		case 'subdomain': case 'subdomains': case 'ms-subdomain':
			return 'subdomain';
		case 'off': case 'no': case 'false': case 'none': case 'single': case '0':
			return 'off';
		default:
			return null;
	}
};

export interface MultisiteDeps {
	wp(site: Local.Site, args: string[]): Promise<string>;
	getSite(id: string): Local.Site | null;
	getStatus(site: Local.Site): string;
	start(site: Local.Site): Promise<void>;
	restart(site: Local.Site): Promise<void>;
	updateSite(id: string, patch: Record<string, unknown>): void;
	syncSubdomains(site: Local.Site): Promise<void>;
	localhostRouting(): boolean;
	/** Folder holding network-switch.php and network-htaccess.php. */
	phpDir: string;
	log(msg: string): void;
}

export interface BlogChange {
	blog_id: number;
	from: { domain: string; path: string };
	to: { domain: string; path: string };
}

export interface MultisiteResult {
	previousMode: NetworkMode;
	mode: NetworkType;
	changed: boolean;
	dryRun: boolean;
	started: boolean;
	steps: string[];
	/** Sub-site rewrites for a subdir/subdomain switch (empty for a conversion). */
	plan: BlogChange[];
	htaccess: HtaccessAction | 'not-apache' | 'not-applicable';
	htaccessSource?: 'core' | 'static';
	/** Set when an existing hand-written .htaccess was left alone. */
	rulesForManualUse?: string;
}

export class MultisiteError extends Error {
	constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) {
		super(message);
	}
}

const serviceByRole = (site: Local.Site, role: string): { name: string; version: string } | undefined =>
	Object.values<any>((site as any).services ?? {}).find((service) => service?.role === role);

/** The last JSON object on stdout; WP-CLI may print notices before it. */
const parseJsonOutput = (output: string): any => {
	const line = output.split(/\r?\n/).reverse().find((candidate) => candidate.trim().startsWith('{'));
	if (!line) {
		throw new MultisiteError(500, `Unexpected WP-CLI output: ${output.trim().slice(-500)}`);
	}
	return JSON.parse(line.trim());
};

const isInstalled = async (deps: MultisiteDeps, site: Local.Site, network: boolean): Promise<boolean> => {
	try {
		await deps.wp(site, ['core', 'is-installed', ...(network ? ['--network'] : [])]);
		return true;
	} catch {
		return false;
	}
};

const currentNetworkMode = async (deps: MultisiteDeps, site: Local.Site): Promise<NetworkType> => {
	// `wp config get` prints "1" for true and nothing for false; no quoting
	// is needed, which keeps this safe on Windows where WP-CLI runs via the shell.
	try {
		const value = (await deps.wp(site, ['config', 'get', 'SUBDOMAIN_INSTALL', '--type=constant'])).trim();
		return value === '1' || value.toLowerCase() === 'true' ? 'subdomain' : 'subdir';
	} catch {
		try {
			const meta = (await deps.wp(site, ['network', 'meta', 'get', '1', 'subdomain_install'])).trim();
			return meta === '1' ? 'subdomain' : 'subdir';
		} catch {
			return 'subdir';
		}
	}
};

const fetchCoreRules = async (deps: MultisiteDeps, site: Local.Site): Promise<string | null> => {
	try {
		const output = (await deps.wp(site, ['eval-file', path.join(deps.phpDir, 'network-htaccess.php')])).trim();
		return output.includes('RewriteEngine On') && output.includes('index.php') ? output : null;
	} catch (err) {
		deps.log(`Could not obtain network rewrite rules from WordPress: ${err?.message ?? err}`);
		return null;
	}
};

const writeHtaccess = async (deps: MultisiteDeps, site: Local.Site, mode: NetworkType, result: MultisiteResult) => {
	const http = serviceByRole(site, 'http');
	if (http?.name !== 'apache') {
		result.htaccess = 'not-apache';
		return;
	}
	const coreRules = await fetchCoreRules(deps, site);
	result.htaccessSource = coreRules ? 'core' : 'static';
	const block = wrapMultisiteBlock(coreRules ?? STATIC_RULES[mode], mode, result.htaccessSource);

	const file = path.join((site as any).paths.webRoot, '.htaccess');
	const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
	const { content, action } = applyMultisiteBlock(existing, block);
	result.htaccess = action;
	if (action === 'skipped') {
		result.rulesForManualUse = block;
		result.steps.push(`left the existing hand-written ${file} alone; add the network rules yourself`);
		return;
	}
	if (content !== null && action !== 'unchanged') {
		fs.writeFileSync(file, content);
		result.steps.push(`${action === 'created' ? 'wrote' : 'updated'} the network rewrite rules in .htaccess (${result.htaccessSource === 'core' ? 'from WordPress core' : 'static fallback'})`);
	}
};

export const changeMultisite = async (
	site: Local.Site,
	target: NetworkType,
	deps: MultisiteDeps,
	dryRun: boolean,
): Promise<MultisiteResult> => {
	const result: MultisiteResult = {
		previousMode: modeFromSite(site),
		mode: target,
		changed: false,
		dryRun,
		started: false,
		steps: [],
		plan: [],
		htaccess: 'not-applicable',
	};

	// WP-CLI needs the site's database, and Local's WP-CLI wrapper needs the
	// site's PHP: both only exist while the site runs.
	if (deps.getStatus(site) !== 'running') {
		await deps.start(site);
		result.started = true;
		result.steps.push('started the site');
	}

	if (!(await isInstalled(deps, site, false))) {
		throw new MultisiteError(409, `WordPress is not installed on "${site.name}", nothing to convert.`);
	}
	const isNetwork = await isInstalled(deps, site, true);
	const previousMode: NetworkMode = isNetwork ? await currentNetworkMode(deps, site) : '';
	result.previousMode = previousMode;

	if (previousMode === target) {
		if (modeFromSite(site) !== target) {
			deps.updateSite(site.id, { multiSite: MS_VALUES[target] });
			result.steps.push('recorded the network mode on the site, Local had it wrong');
		}
		result.steps.push(`already a ${target} network`);
		return result;
	}
	if (target === 'subdomain' && deps.localhostRouting()) {
		throw new MultisiteError(400, 'A subdomain network is impossible while Local routes sites through localhost. Switch the router mode to site domains in Local\'s preferences first.');
	}

	const subdomains = target === 'subdomain';
	if (!isNetwork) {
		const title = os.platform() === 'win32' ? `--title="${site.name}"` : `--title=${site.name}`;
		const args = ['core', 'multisite-convert', title, ...(subdomains ? ['--subdomains'] : [])];
		if (dryRun) {
			result.steps.push(`would run: wp ${args.join(' ')}`);
		} else {
			deps.log(`Converting "${site.name}" (${site.id}) to a ${target} network`);
			await deps.wp(site, args);
			result.steps.push(`converted to a ${target} network (wp core multisite-convert)`);
		}
	} else {
		const output = await deps.wp(site, ['eval-file', path.join(deps.phpDir, 'network-switch.php'), target, dryRun ? 'plan' : 'apply']);
		const parsed = parseJsonOutput(output);
		result.plan = Array.isArray(parsed.plan) ? parsed.plan : [];
		if (!parsed.ok) {
			throw new MultisiteError(409, parsed.error ?? 'The network switch was refused.', { errors: parsed.errors ?? [], plan: result.plan });
		}
		const count = result.plan.length;
		if (dryRun) {
			result.steps.push(`would rewrite ${count} sub-site${count === 1 ? '' : 's'} and set SUBDOMAIN_INSTALL to ${subdomains}`);
		} else {
			result.steps.push(`rewrote ${count} sub-site${count === 1 ? '' : 's'} to ${target} addresses`);
			await deps.wp(site, ['config', 'set', 'SUBDOMAIN_INSTALL', subdomains ? 'true' : 'false', '--raw', '--type=constant']);
			result.steps.push(`set SUBDOMAIN_INSTALL to ${subdomains} in wp-config.php`);
		}
	}

	if (dryRun) {
		result.steps.push('would record the mode on the site, update .htaccess on Apache, sync sub-site domains and restart the site');
		return result;
	}

	deps.updateSite(site.id, { multiSite: MS_VALUES[target] });
	const fresh = deps.getSite(site.id) ?? site;
	result.steps.push(`recorded the ${target} network mode on the site`);

	await writeHtaccess(deps, fresh, target, result);

	try {
		await deps.syncSubdomains(fresh);
		result.steps.push('synced sub-site domains to the hosts file and reloaded the router');
	} catch (err) {
		result.steps.push(`sub-site domain sync failed: ${err?.message ?? err}`);
	}

	await deps.restart(fresh);
	result.steps.push('restarted the site');
	result.changed = true;
	return result;
};

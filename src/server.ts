import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import type * as Local from '@getflywheel/local';
import {
	CONTENT_TYPES, Format, addSiteText, candidateTable, changeServiceText, multisiteText, openText, pingText,
	servicesText, siteTable, sslText, transitionText,
} from './format';
import { BUILT_IN_SITE_DEFAULTS, NewSiteDefaults, deriveDomain, expandHome, formatSiteNicename, validateNewSite } from './new-site';
import { MS_VALUES, MultisiteDeps, MultisiteError, MultisiteResult, NetworkType, changeMultisite, modeFromSite, parseNetworkTarget } from './multisite';
import {
	Platform, TrustCommand, buildTrustScript, commandLine, findOnPath, inSystemKeychain, trustCommands, verifiesForSsl,
} from './ssl';
import { SERVICE_ROLES, ServiceCatalog, ServiceRole, isValidVersionSpec, resolveVersion } from './versions';

/**
 * The slice of Local's main-process services the bridge needs. Kept as an
 * interface so the request handling can be reasoned about (and tested)
 * without Local's service container.
 */
export interface SiteBackend {
	getSites(): Local.Site[];
	getSite(id: string): Local.Site | null;
	getSiteByDomain(domain: string): Local.Site | null;
	getStatus(site: Local.Site): string;
	start(site: Local.Site): Promise<void>;
	stop(site: Local.Site): Promise<void>;
	restart(site: Local.Site): Promise<void>;
	/** Installed plus downloadable versions for a role, as Local's "Custom" environment picker lists them. */
	getServices(role: ServiceRole): Promise<ServiceCatalog>;
	getNewSiteDefaults(): Partial<NewSiteDefaults>;
	addSite(input: AddSiteInput): Promise<Local.Site>;
	swapService(site: Local.Site, role: ServiceRole, serviceName: string, version: string): Promise<void>;
	openInBrowser(url: string): void;
	openDatabase(site: Local.Site): Promise<void>;
	wpCli(site: Local.Site, args: string[]): Promise<string>;
	updateSite(id: string, patch: Record<string, unknown>): void;
	syncSubdomains(site: Local.Site): Promise<void>;
	localhostRouting(): boolean;
	/** Path of the site's certificate in Local's router folder, whether or not it exists yet. */
	siteCertPath(site: Local.Site): string;
	/** Generate the site's certificate when it does not exist yet, as Local does on first start. */
	ensureSiteCert(site: Local.Site): Promise<void>;
	/** Local's own trust check: the certificate is present in the system store. */
	certTrustedByLocal(site: Local.Site): Promise<boolean>;
	/** Tell Local's UI the certificate is trusted, so the SSL tab shows "Trusted". */
	notifyCertTrusted(site: Local.Site): void;
	/** Press Local's Trust button: whatever handles the trustSiteCert channel, Local or an add-on that took it over. */
	trustViaLocal(site: Local.Site): Promise<void>;
}

export interface AddSiteInput {
	newSiteInfo: Record<string, unknown>;
	wpCredentials: { adminUsername: string; adminPassword: string; adminEmail: string };
	goToSite: boolean;
	installWP: boolean;
	siteLanguage: string;
}

export interface BridgeInfo {
	addonVersion: string;
	localVersion: string;
	/** Folder holding the PHP helpers run through WP-CLI. */
	phpDir: string;
}

export interface SiteSummary {
	id: string;
	name: string;
	domain: string;
	url: string;
	path: string;
	status: string;
	multisite: '' | NetworkType;
	services: Record<string, string>;
}

export interface ServiceRow {
	role: ServiceRole;
	name: string;
	version: string;
	installed: boolean;
}

export type OpenTarget = 'site' | 'admin' | 'mailpit' | 'db';

export interface OpenResult extends SiteSummary {
	target: OpenTarget;
	openUrl: string;
	opened: boolean;
	autoLogin: boolean;
}

export interface AddSiteResult extends SiteSummary {
	/** True when the reply went out before provisioning finished (`--no-wait`). */
	pending: boolean;
	credentials: { username: string; password: string; email: string };
}

export interface ChangeServiceResult extends SiteSummary {
	op: string;
	from: string;
	to: string;
	changed: boolean;
	downloaded: boolean;
}

export type MultisiteReply = SiteSummary & MultisiteResult;

export interface SslStatus extends SiteSummary {
	certPath: string;
	keyPath: string;
	trusted: boolean;
	/** macOS only: the certificate sits in the System keychain, trusted for SSL or not. Null elsewhere. */
	inKeychain: boolean | null;
	platform: Platform;
	/** The shell lines that trust the certificate, in order; empty when this platform has no recipe. */
	commands: string[];
	/** Why `commands` is empty, when it is. */
	commandsError: string;
}

export interface TrustResult extends SslStatus {
	via: 'shell' | 'local';
	changed: boolean;
	/** Local's own flow was triggered but has not finished yet (an add-on opened a Terminal, say). */
	pending: boolean;
}

export interface TrustScript extends SslStatus {
	script: string;
}

export class HttpError extends Error {
	constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) {
		super(message);
	}
}

const serviceByRole = (site: Local.Site, role: string): { name: string; version: string } | undefined =>
	Object.values<any>((site as any).services ?? {}).find((service) => service?.role === role);

export const summarize = (site: Local.Site, status: string): SiteSummary => {
	const services: Record<string, string> = {};
	for (const [key, service] of Object.entries<any>((site as any).services ?? {})) {
		if (service?.version) {
			services[key] = `${service.name ?? key} ${service.version}`;
		}
	}
	const domain = (site as any).domain ?? '';
	return {
		id: site.id,
		name: site.name,
		domain,
		url: (site as any).url ?? (domain ? `http://${domain}` : ''),
		path: (site as any).longPath ?? (site as any).path ?? '',
		status,
		multisite: modeFromSite(site),
		services,
	};
};

/**
 * Accepts whatever a human would type: the site ID, the domain, the exact
 * name (case-insensitive) or, failing those, a unique prefix of name/domain.
 */
export const resolveSite = (sites: Local.Site[], ref: string): Local.Site => {
	const needle = (ref ?? '').trim().toLowerCase();
	if (!needle) {
		throw new HttpError(400, 'Missing site reference: pass a site ID, domain or name, or set LOCAL_SITE_ID / LOCAL_SITE_NAME.');
	}

	const exact = sites.find((site) =>
		site.id === ref.trim()
		|| (site as any).domain?.toLowerCase() === needle
		|| site.name?.toLowerCase() === needle);
	if (exact) {
		return exact;
	}

	const partial = sites.filter((site) =>
		site.name?.toLowerCase().startsWith(needle)
		|| (site as any).domain?.toLowerCase().startsWith(needle));
	if (partial.length === 1) {
		return partial[0];
	}
	if (partial.length > 1) {
		throw new HttpError(400, `Site reference "${ref}" is ambiguous.`, {
			candidates: partial.map((site) => ({ id: site.id, name: site.name, domain: (site as any).domain })),
		});
	}
	throw new HttpError(404, `No site matches "${ref}" (tried ID, domain and name).`);
};

/** A response as data, plus how to say it in the text formats. */
interface Reply {
	data: unknown;
	text: (format: Format) => string;
}

interface Request {
	params: URLSearchParams;
	pathParams: string[];
}

interface Route {
	method: string;
	pattern: RegExp;
	handler: (req: Request) => Promise<Reply>;
}

const readBody = (req: http.IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
	let body = '';
	req.setEncoding('utf8');
	req.on('data', (chunk) => { body += chunk; });
	req.on('end', () => resolve(body));
	req.on('error', reject);
});

const pickFormat = (params: URLSearchParams, accept: string): Format => {
	const requested = params.get('format');
	if (requested === 'json' || requested === 'table' || requested === 'plain') {
		return requested;
	}
	return accept.includes('text/plain') ? 'table' : 'json';
};

const flag = (params: URLSearchParams, name: string): boolean => {
	const value = (params.get(name) ?? '').trim().toLowerCase();
	return value === '1' || value === 'true' || value === 'yes' || value === 'on';
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const createBridgeServer = (backend: SiteBackend, info: BridgeInfo, log: (msg: string) => void): http.Server => {
	/**
	 * The site may come from the path (`/sites/{ref}/start`, handy with curl)
	 * or from a `site` query/body parameter (what the shell client sends,
	 * because curl URL-encodes those reliably).
	 */
	const siteFrom = ({ params, pathParams }: Request) =>
		resolveSite(backend.getSites(), pathParams[0] !== undefined ? decodeURIComponent(pathParams[0]) : params.get('site') ?? '');

	const withStatus = (site: Local.Site): SiteSummary => summarize(site, backend.getStatus(site));

	const transition = async (req: Request, action: 'start' | 'stop' | 'restart'): Promise<Reply> => {
		const site = siteFrom(req);
		const before = backend.getStatus(site);
		const noop = (action === 'start' && before === 'running') || (action === 'stop' && before === 'halted');
		if (!noop) {
			log(`${action} "${site.name}" (${site.id}), current status: ${before}`);
			await backend[action](site);
		}
		const data = { ...withStatus(site), action, changed: !noop, previousStatus: before };
		return { data, text: (format) => transitionText(data, format) };
	};

	const status = async (req: Request): Promise<Reply> => {
		const data = withStatus(siteFrom(req));
		return { data, text: (format) => siteTable([data], format) };
	};

	/**
	 * Resolve `<service> <spec>` to a concrete version the way Local does:
	 * exact match, else the newest patch release of that major.minor, over
	 * the installed and downloadable versions combined.
	 */
	const resolveService = async (name: string, spec?: string): Promise<{ name: string; version: string; installed: boolean }> => {
		const role = SERVICE_ROLES[name];
		if (!role) {
			throw new HttpError(400, `Unknown service "${name}". Use php, mysql, mariadb, apache or nginx.`);
		}
		const wanted = (spec ?? '').trim();
		if (wanted && !isValidVersionSpec(wanted)) {
			throw new HttpError(400, `"${wanted}" is not a version. Use an exact version like 8.3.30 or a major.minor like 8.3.`);
		}
		const catalog = await backend.getServices(role);
		const versions = Object.keys(catalog[name] ?? {});
		if (!versions.length) {
			throw new HttpError(409, `Local offers no ${name} service at all on this machine.`);
		}
		// A bare service name (`--apache`, `change-site … nginx`) means "what is
		// installed", never a download; an explicit version means "newest that
		// matches", downloaded if need be.
		const installed = versions.filter((candidate) => catalog[name][candidate]?.registered);
		const version = wanted ? resolveVersion(versions, wanted) : resolveVersion(installed.length ? installed : versions);
		if (!version) {
			throw new HttpError(400, `No ${name} version matches "${wanted}". Available: ${versions.join(', ')}.`);
		}
		return { name, version, installed: !!catalog[name][version]?.registered };
	};

	const listServices = async ({ params }: Request): Promise<Reply> => {
		const requested = (params.get('role') ?? '').trim().toLowerCase();
		const roles: ServiceRole[] = requested ? [SERVICE_ROLES[requested] ?? (requested as ServiceRole)] : ['php', 'db', 'http'];
		if (roles.some((role) => !['php', 'db', 'http'].includes(role))) {
			throw new HttpError(400, `Unknown role "${requested}". Use php, db (mysql/mariadb) or http (apache/nginx).`);
		}
		const rows: ServiceRow[] = [];
		for (const role of roles) {
			const catalog = await backend.getServices(role);
			for (const [name, versions] of Object.entries(catalog)) {
				for (const [version, details] of Object.entries(versions)) {
					rows.push({ role, name, version, installed: !!details?.registered });
				}
			}
		}
		return { data: rows, text: (format) => servicesText(rows, format) };
	};

	const addSite = async ({ params }: Request): Promise<Reply> => {
		const name = (params.get('name') ?? '').trim();
		if (!name) {
			throw new HttpError(400, 'A site name is required.');
		}
		const defaults: NewSiteDefaults = { ...BUILT_IN_SITE_DEFAULTS, ...backend.getNewSiteDefaults() };
		const nicename = formatSiteNicename(name);
		const domain = (params.get('domain') ?? '').trim().toLowerCase() || deriveDomain(nicename, defaults.tld);
		const sitesPath = path.resolve(expandHome(defaults.sitesPath));
		const sitePath = path.join(sitesPath, nicename);

		const error = validateNewSite({
			name,
			domain,
			sitePath,
			sitesPath,
			existingSites: backend.getSites().map((site) => ({
				domain: (site as any).domain ?? '',
				path: path.resolve(expandHome((site as any).path ?? '')),
			})),
			pathHasLocalData: fs.existsSync(path.join(sitePath, 'app')) || fs.existsSync(path.join(sitePath, 'conf')),
			platform: process.platform,
		});
		if (error) {
			throw new HttpError(400, error);
		}

		const multisiteParam = (params.get('multisite') ?? '').trim();
		const multisite = multisiteParam ? parseNetworkTarget(multisiteParam) : 'off';
		if (multisite === null) {
			throw new HttpError(400, `Unknown multisite mode "${multisiteParam}". Use subdir or subdomain.`);
		}
		if (multisite === 'subdomain' && backend.localhostRouting()) {
			throw new HttpError(400, 'A subdomain network is impossible while Local routes sites through localhost. Switch the router mode to site domains in Local\'s preferences first.');
		}

		const webServers = params.getAll('webserver').map((value) => value.trim().toLowerCase()).filter(Boolean);
		if (webServers.length > 1) {
			throw new HttpError(400, '--apache and --nginx are mutually exclusive.');
		}
		if (webServers.length && !['apache', 'nginx'].includes(webServers[0])) {
			throw new HttpError(400, `Unknown web server "${webServers[0]}". Use --apache or --nginx.`);
		}
		const mysql = (params.get('mysql') ?? '').trim();
		const mariadb = (params.get('mariadb') ?? '').trim();
		if (mysql && mariadb) {
			throw new HttpError(400, '--mysql and --mariadb are mutually exclusive.');
		}
		const phpSpec = (params.get('php') ?? '').trim();

		// Like the Add Site dialog: no service choices means Local's "Preferred"
		// environment and Local's own preferred versions; any choice means
		// "Custom", with Local filling the services that were not chosen.
		const php = phpSpec ? await resolveService('php', phpSpec) : null;
		const database = mysql ? await resolveService('mysql', mysql) : mariadb ? await resolveService('mariadb', mariadb) : null;
		const webServer = webServers.length ? await resolveService(webServers[0], params.get('webserver-version') ?? '') : null;
		const custom = !!(php || database || webServer);

		const newSiteInfo: Record<string, unknown> = {
			siteName: name,
			sitePath,
			siteDomain: domain,
			multiSite: multisite === 'off' ? '' : MS_VALUES[multisite],
			environment: custom ? 'custom' : 'flywheel',
			xdebugEnabled: false,
		};
		if (php) {
			newSiteInfo.phpVersion = php.version;
		}
		if (database) {
			newSiteInfo.database = `${database.name}-${database.version}`;
		}
		if (webServer) {
			newSiteInfo.webServer = `${webServer.name}-${webServer.version}`;
		}

		const wpCredentials = {
			adminUsername: (params.get('admin-user') ?? '').trim() || 'admin',
			adminPassword: params.get('admin-password') || 'admin',
			adminEmail: (params.get('admin-email') ?? '').trim() || defaults.adminEmail,
		};
		if (!/^[^\s@]+@[^\s@]+$/.test(wpCredentials.adminEmail)) {
			throw new HttpError(400, `"${wpCredentials.adminEmail}" is not an email address.`);
		}

		log(`add-site "${name}" -> ${domain} at ${sitePath} (${custom ? 'custom' : 'preferred'} environment${multisite === 'off' ? '' : `, ${multisite} network`})`);
		const creation = backend.addSite({
			newSiteInfo,
			wpCredentials,
			goToSite: true,
			installWP: true,
			siteLanguage: defaults.siteLanguage,
		});
		creation.catch((err) => log(`add-site "${name}" failed: ${err?.stack ?? err}`));

		const describe = (site: Local.Site, pending: boolean): AddSiteResult => ({
			...withStatus(site),
			pending,
			credentials: { username: wpCredentials.adminUsername, password: wpCredentials.adminPassword, email: wpCredentials.adminEmail },
		});

		if (!flag(params, 'no-wait')) {
			let site: Local.Site;
			try {
				site = await creation;
			} catch (err) {
				throw new HttpError(500, `Local could not create "${name}": ${err?.message ?? err}. Local may be showing an error dialog; the site may need to be deleted by hand.`);
			}
			const data = describe(backend.getSite(site.id) ?? site, false);
			return { data, text: (format) => addSiteText(data, format) };
		}

		// Local registers the site synchronously, well before provisioning ends.
		const deadline = Date.now() + 5000;
		let site = backend.getSiteByDomain(domain);
		while (!site && Date.now() < deadline) {
			await sleep(100);
			site = backend.getSiteByDomain(domain);
		}
		if (!site) {
			await creation; // surfaces the real error when creation blew up early
			throw new HttpError(500, `Local did not register "${name}"; check Local's log.`);
		}
		const data = describe(site, true);
		return { data, text: (format) => addSiteText(data, format) };
	};

	const changeService = async (site: Local.Site, op: string, spec: string): Promise<Reply> => {
		if (op === 'php' && !spec) {
			throw new HttpError(400, 'change-site … php needs a version, e.g. 8.3 or 8.3.30.');
		}
		if ((op === 'mysql' || op === 'mariadb') && !spec) {
			throw new HttpError(400, `change-site … ${op} needs a version, e.g. ${op === 'mysql' ? '8.4' : '10.11'}.`);
		}
		const role = SERVICE_ROLES[op];
		const target = await resolveService(op, spec);
		const current = serviceByRole(site, role);
		const from = current ? `${current.name} ${current.version}` : '(none)';
		const to = `${target.name} ${target.version}`;

		if (current?.name === target.name && current?.version === target.version) {
			const data: ChangeServiceResult = { ...withStatus(site), op, from, to, changed: false, downloaded: false };
			return { data, text: (format) => changeServiceText(data, format) };
		}

		log(`change-site "${site.name}" (${site.id}): ${from} -> ${to}${target.installed ? '' : ' (download required)'}`);
		await backend.swapService(site, role, target.name, target.version);

		// Local's swap never rejects: on failure it shows a dialog, reverts the
		// site's services and marks the site stalled. Verify the outcome instead.
		const fresh = backend.getSite(site.id) ?? site;
		const after = serviceByRole(fresh, role);
		if (after?.name !== target.name || after?.version !== target.version) {
			throw new HttpError(500, `Local could not switch "${site.name}" to ${to}; it is back on ${after ? `${after.name} ${after.version}` : 'no service'} (status ${backend.getStatus(fresh)}). Local is showing the error in a dialog and logged it.`);
		}
		const data: ChangeServiceResult = { ...withStatus(fresh), op, from, to, changed: true, downloaded: !target.installed };
		return { data, text: (format) => changeServiceText(data, format) };
	};

	const changeMultisiteHandler = async (site: Local.Site, value: string, dryRun: boolean): Promise<Reply> => {
		const target = parseNetworkTarget(value);
		if (target === null) {
			throw new HttpError(400, `change-site … multisite needs a mode: subdir or subdomain${value ? `, got "${value}"` : ''}.`);
		}
		if (target === 'off') {
			throw new HttpError(400, 'Turning a network back into a single site is not supported: it means dropping the network tables and every sub-site. Do that by hand if you really want it.');
		}
		const deps: MultisiteDeps = {
			wp: backend.wpCli,
			getSite: backend.getSite,
			getStatus: backend.getStatus,
			start: backend.start,
			restart: backend.restart,
			updateSite: backend.updateSite,
			syncSubdomains: backend.syncSubdomains,
			localhostRouting: backend.localhostRouting,
			phpDir: info.phpDir,
			log,
		};
		let result: MultisiteResult;
		try {
			result = await changeMultisite(site, target, deps, dryRun);
		} catch (err) {
			if (err instanceof MultisiteError) {
				throw new HttpError(err.status, err.message, err.extra);
			}
			throw err;
		}
		const fresh = backend.getSite(site.id) ?? site;
		const data: MultisiteReply = { ...withStatus(fresh), ...result };
		return { data, text: (format) => multisiteText(data, format) };
	};

	const change = async (req: Request): Promise<Reply> => {
		const site = siteFrom(req);
		const op = (req.params.get('op') ?? '').trim().toLowerCase();
		const value = (req.params.get('value') ?? '').trim();
		switch (op) {
			case 'multisite':
				return changeMultisiteHandler(site, value, flag(req.params, 'dry-run'));
			case 'php': case 'mysql': case 'mariadb': case 'apache': case 'nginx':
				return changeService(site, op, value);
			case '':
				throw new HttpError(400, 'change-site needs an operation: php, mysql, mariadb, apache, nginx or multisite.');
			default:
				throw new HttpError(400, `Unknown change-site operation "${op}". Use php, mysql, mariadb, apache, nginx or multisite.`);
		}
	};

	const firstAdminId = async (site: Local.Site): Promise<string | null> => {
		try {
			const output = await backend.wpCli(site, ['user', 'list', '--role=administrator', '--field=ID', '--orderby=ID', '--order=ASC']);
			const id = output.trim().split(/\r?\n/)[0]?.trim();
			return id && /^\d+$/.test(id) ? id : null;
		} catch {
			return null;
		}
	};

	const open = async (req: Request): Promise<Reply> => {
		const { params } = req;
		const site = siteFrom(req);
		const target = ((params.get('target') ?? 'site').trim().toLowerCase() || 'site') as OpenTarget;
		if (!['site', 'admin', 'mailpit', 'db'].includes(target)) {
			throw new HttpError(400, `Unknown open target "${target}".`);
		}
		const printOnly = flag(params, 'url');
		const autoLogin = target === 'admin' && flag(params, 'auto-login');

		if (backend.getStatus(site) !== 'running') {
			if (flag(params, 'start')) {
				log(`start "${site.name}" (${site.id}) before opening ${target}`);
				await backend.start(site);
			} else if (!printOnly || target === 'db' || autoLogin) {
				throw new HttpError(409, `"${site.name}" is ${backend.getStatus(site)}; start it first or pass --start.`);
			}
		}

		let url: string;
		switch (target) {
			case 'site':
				url = (site as any).url;
				break;
			case 'admin': {
				url = (site as any).adminUrl ?? `${(site as any).url}/wp-admin/`;
				if (autoLogin) {
					const id = (site as any).oneClickAdminID ?? await firstAdminId(site);
					if (!id) {
						throw new HttpError(409, `No One-click admin user is set for "${site.name}" and no administrator could be found.`);
					}
					url += `${url.includes('?') ? '&' : '?'}localwp_auto_login=${id}`;
				}
				break;
			}
			case 'mailpit': {
				const port = (site as any).services?.mailpit?.ports?.WEB?.[0];
				if (!port) {
					throw new HttpError(409, `Mailpit has no port for "${site.name}" yet; start the site once.`);
				}
				url = `http://localhost:${port}`;
				break;
			}
			case 'db': {
				if (printOnly) {
					throw new HttpError(400, 'The database manager gets its port when it is opened, so there is no URL to print.');
				}
				log(`open database manager for "${site.name}" (${site.id})`);
				await backend.openDatabase(site);
				const data: OpenResult = { ...withStatus(site), target, openUrl: '', opened: true, autoLogin: false };
				return { data, text: (format) => openText(data, format) };
			}
		}

		if (!printOnly) {
			log(`open ${target} of "${site.name}" (${site.id}): ${url}`);
			backend.openInBrowser(url);
		}
		const data: OpenResult = { ...withStatus(site), target, openUrl: url, opened: !printOnly, autoLogin };
		return { data, text: (format) => openText(data, format) };
	};

	/**
	 * Where the certificate stands. On macOS "trusted" means it verifies under
	 * the SSL policy, which is what browsers care about; Local only checks the
	 * keychain for the certificate and so calls its own silently failed trusts
	 * trusted. Elsewhere Local's check is the one that exists.
	 */
	const sslStatus = async (site: Local.Site): Promise<SslStatus> => {
		const domain = (site as any).domain as string;
		const certPath = backend.siteCertPath(site);
		const keyPath = certPath.replace(/\.crt$/, '.key');
		if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
			log(`generate certificate for "${site.name}" (${site.id})`);
			await backend.ensureSiteCert(site);
		}
		if (!fs.existsSync(certPath)) {
			throw new HttpError(409, `Local has no certificate for "${domain}" (expected ${certPath}); start the site once and try again.`);
		}
		const platform = process.platform as Platform;
		let trusted: boolean;
		let inKeychain: boolean | null = null;
		if (platform === 'darwin') {
			inKeychain = await inSystemKeychain(certPath);
			trusted = inKeychain && await verifiesForSsl(certPath, domain);
		} else {
			trusted = await backend.certTrustedByLocal(site);
		}
		let commands: TrustCommand[] = [];
		let commandsError = '';
		try {
			commands = trustCommands(platform, certPath, domain, { certutil: findOnPath('certutil') });
		} catch (err) {
			commandsError = err?.message ?? String(err);
		}
		return { ...withStatus(site), certPath, keyPath, trusted, inKeychain, platform, commands: commands.map(commandLine), commandsError };
	};

	const ssl = async (req: Request): Promise<Reply> => {
		const data = await sslStatus(siteFrom(req));
		return { data, text: (format) => sslText(data, format) };
	};

	/** The script the client runs in its own terminal; sudo prompts there. */
	const sslScript = async (req: Request): Promise<Reply> => {
		const site = siteFrom(req);
		const status = await sslStatus(site);
		if (status.platform === 'win32') {
			throw new HttpError(409, `There is no shell recipe for Windows. Run this in an elevated prompt:\n  ${status.commands.join('\n  ')}\nor pass --gui to let Local ask for elevation.`);
		}
		if (!status.commands.length) {
			throw new HttpError(409, status.commandsError || 'No trust commands are known for this platform.');
		}
		const commands = trustCommands(status.platform, status.certPath, status.domain, { certutil: findOnPath('certutil') });
		const data: TrustScript = { ...status, script: buildTrustScript(status.domain, status.certPath, commands) };
		return { data, text: () => data.script };
	};

	/**
	 * `gui=1`: press Local's Trust button. Without it: the client has just run
	 * the script, so re-check and, when it worked, flip Local's SSL tab to
	 * "Trusted".
	 */
	const sslTrust = async (req: Request): Promise<Reply> => {
		const site = siteFrom(req);
		const gui = flag(req.params, 'gui');
		let before = await sslStatus(site);
		// Fresh trust settings can take a moment to show up; the client has just
		// run sudo, so give macOS a few seconds before calling it a failure.
		for (let attempt = 0; !gui && !before.trusted && attempt < 5; attempt++) {
			await sleep(1000);
			before = await sslStatus(site);
		}
		if (before.trusted) {
			backend.notifyCertTrusted(site);
			const data: TrustResult = { ...before, via: gui ? 'local' : 'shell', changed: !flag(req.params, 'already'), pending: false };
			return { data, text: (format) => sslText(data, format) };
		}
		if (!gui) {
			throw new HttpError(409, before.inKeychain === true
				? `The certificate for "${before.domain}" is in the System keychain but still not trusted for SSL.`
				: `The certificate for "${before.domain}" is still not trusted.`);
		}
		log(`trust certificate of "${site.name}" (${site.id}) through Local's own Trust flow`);
		await backend.trustViaLocal(site);
		const after = await sslStatus(site);
		if (after.trusted) {
			backend.notifyCertTrusted(site);
		}
		const data: TrustResult = { ...after, via: 'local', changed: after.trusted, pending: !after.trusted };
		return { data, text: (format) => sslText(data, format) };
	};

	const routes: Route[] = [
		{
			method: 'GET',
			pattern: /^\/(ping)?$/,
			handler: async () => {
				const data = { ok: true, addonVersion: info.addonVersion, localVersion: info.localVersion, pid: process.pid };
				return { data, text: (format) => pingText(data, format) };
			},
		},
		{
			method: 'GET',
			pattern: /^\/sites$/,
			handler: async () => {
				const data = backend.getSites().map(withStatus);
				return { data, text: (format) => siteTable(data, format) };
			},
		},
		{ method: 'POST', pattern: /^\/sites$/, handler: addSite },
		{ method: 'GET', pattern: /^\/services$/, handler: listServices },
		{ method: 'GET', pattern: /^\/site$/, handler: status },
		{ method: 'GET', pattern: /^\/sites\/([^/]+)$/, handler: status },
		{ method: 'POST', pattern: /^\/site\/start$/, handler: (req) => transition(req, 'start') },
		{ method: 'POST', pattern: /^\/site\/stop$/, handler: (req) => transition(req, 'stop') },
		{ method: 'POST', pattern: /^\/site\/restart$/, handler: (req) => transition(req, 'restart') },
		{ method: 'POST', pattern: /^\/site\/change$/, handler: change },
		{ method: 'POST', pattern: /^\/site\/open$/, handler: open },
		{ method: 'GET', pattern: /^\/site\/ssl$/, handler: ssl },
		{ method: 'GET', pattern: /^\/site\/ssl\/script$/, handler: sslScript },
		{ method: 'POST', pattern: /^\/site\/ssl\/trust$/, handler: sslTrust },
		{ method: 'GET', pattern: /^\/sites\/([^/]+)\/ssl$/, handler: ssl },
		{ method: 'GET', pattern: /^\/sites\/([^/]+)\/ssl\/script$/, handler: sslScript },
		{ method: 'POST', pattern: /^\/sites\/([^/]+)\/ssl\/trust$/, handler: sslTrust },
		{ method: 'POST', pattern: /^\/sites\/([^/]+)\/start$/, handler: (req) => transition(req, 'start') },
		{ method: 'POST', pattern: /^\/sites\/([^/]+)\/stop$/, handler: (req) => transition(req, 'stop') },
		{ method: 'POST', pattern: /^\/sites\/([^/]+)\/restart$/, handler: (req) => transition(req, 'restart') },
		{ method: 'POST', pattern: /^\/sites\/([^/]+)\/change$/, handler: change },
		{ method: 'POST', pattern: /^\/sites\/([^/]+)\/open$/, handler: open },
	];

	const send = (res: http.ServerResponse, status: number, format: Format, body: string) => {
		res.writeHead(status, { 'Content-Type': CONTENT_TYPES[format] });
		res.end(body.endsWith('\n') ? body : body + '\n');
	};

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url ?? '/', 'http://bridge');
		const pathname = url.pathname.replace(/\/+$/, '') || '/';
		const method = (req.method ?? 'GET').toUpperCase();
		const params = url.searchParams;
		let format: Format = 'json';

		try {
			const body = await readBody(req);
			if ((req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) {
				for (const [key, value] of new URLSearchParams(body)) {
					params.append(key, value);
				}
			}
			format = pickFormat(params, String(req.headers.accept ?? ''));

			const matching = routes.filter((candidate) => candidate.pattern.test(pathname));
			if (!matching.length) {
				throw new HttpError(404, `Unknown endpoint ${pathname}.`);
			}
			const route = matching.find((candidate) => candidate.method === method);
			if (!route) {
				throw new HttpError(405, `${pathname} expects ${matching.map((candidate) => candidate.method).join(' or ')}, got ${method}.`);
			}
			const pathParams = pathname.match(route.pattern).slice(1);
			const reply = await route.handler({ params, pathParams });
			send(res, 200, format, format === 'json' ? JSON.stringify(reply.data, null, 2) : reply.text(format));
		} catch (err) {
			const status = err instanceof HttpError ? err.status : 500;
			const extra = err instanceof HttpError ? err.extra : {};
			if (status === 500) {
				log(`request ${method} ${pathname} failed: ${err?.stack ?? err}`);
			}
			const message = err?.message ?? String(err);
			if (format === 'json') {
				send(res, status, format, JSON.stringify({ error: message, ...extra }, null, 2));
				return;
			}
			const lines = [message];
			if (Array.isArray(extra.candidates)) {
				lines.push(candidateTable(extra.candidates as any[], format));
			}
			if (Array.isArray(extra.errors)) {
				lines.push(...(extra.errors as string[]).map((line) => `  - ${line}`));
			}
			send(res, status, format, lines.join('\n'));
		}
	});

	// Creating a site or swapping a service can take minutes (downloads,
	// WordPress install); never let the HTTP layer cut a legitimate request short.
	server.timeout = 0;
	server.requestTimeout = 0;
	server.headersTimeout = 0;
	server.keepAliveTimeout = 0;

	return server;
};

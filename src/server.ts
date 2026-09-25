import * as http from 'http';
import type * as Local from '@getflywheel/local';
import { CONTENT_TYPES, Format, candidateTable, pingText, siteTable, transitionText } from './format';

/**
 * The slice of Local's main-process services the bridge needs. Kept as an
 * interface so the request handling can be reasoned about (and tested)
 * without Local's service container.
 */
export interface SiteBackend {
	getSites(): Local.Site[];
	getStatus(site: Local.Site): string;
	start(site: Local.Site): Promise<void>;
	stop(site: Local.Site): Promise<void>;
	restart(site: Local.Site): Promise<void>;
}

export interface BridgeInfo {
	addonVersion: string;
	localVersion: string;
}

export interface SiteSummary {
	id: string;
	name: string;
	domain: string;
	url: string;
	path: string;
	status: string;
	services: Record<string, string>;
}

class HttpError extends Error {
	constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) {
		super(message);
	}
}

const summarize = (site: Local.Site, status: string): SiteSummary => {
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
		throw new HttpError(400, 'Missing site reference: pass a site ID, domain or name.');
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

export const createBridgeServer = (backend: SiteBackend, info: BridgeInfo, log: (msg: string) => void): http.Server => {
	/**
	 * The site may come from the path (`/sites/{ref}/start`, handy with curl)
	 * or from a `site` query/body parameter (what the shell client sends,
	 * because curl URL-encodes those reliably).
	 */
	const siteFrom = ({ params, pathParams }: Request) =>
		resolveSite(backend.getSites(), pathParams[0] !== undefined ? decodeURIComponent(pathParams[0]) : params.get('site') ?? '');

	const transition = async (req: Request, action: 'start' | 'stop' | 'restart'): Promise<Reply> => {
		const site = siteFrom(req);
		const before = backend.getStatus(site);
		const noop = (action === 'start' && before === 'running') || (action === 'stop' && before === 'halted');
		if (!noop) {
			log(`${action} "${site.name}" (${site.id}), current status: ${before}`);
			await backend[action](site);
		}
		const data = { ...summarize(site, backend.getStatus(site)), action, changed: !noop, previousStatus: before };
		return { data, text: (format) => transitionText(data, format) };
	};

	const status = async (req: Request): Promise<Reply> => {
		const site = siteFrom(req);
		const data = summarize(site, backend.getStatus(site));
		return { data, text: (format) => siteTable([data], format) };
	};

	const routes: Route[] = [
		{
			method: 'GET',
			pattern: /^\/(ping)?$/,
			handler: async () => {
				const data = { ok: true, ...info, pid: process.pid };
				return { data, text: (format) => pingText(data, format) };
			},
		},
		{
			method: 'GET',
			pattern: /^\/sites$/,
			handler: async () => {
				const data = backend.getSites().map((site) => summarize(site, backend.getStatus(site)));
				return { data, text: (format) => siteTable(data, format) };
			},
		},
		{ method: 'GET', pattern: /^\/site$/, handler: status },
		{ method: 'GET', pattern: /^\/sites\/([^/]+)$/, handler: status },
		{ method: 'POST', pattern: /^\/site\/(?:start)$/, handler: (req) => transition(req, 'start') },
		{ method: 'POST', pattern: /^\/site\/(?:stop)$/, handler: (req) => transition(req, 'stop') },
		{ method: 'POST', pattern: /^\/site\/(?:restart)$/, handler: (req) => transition(req, 'restart') },
		{ method: 'POST', pattern: /^\/sites\/([^/]+)\/start$/, handler: (req) => transition(req, 'start') },
		{ method: 'POST', pattern: /^\/sites\/([^/]+)\/stop$/, handler: (req) => transition(req, 'stop') },
		{ method: 'POST', pattern: /^\/sites\/([^/]+)\/restart$/, handler: (req) => transition(req, 'restart') },
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
					params.set(key, value);
				}
			}
			format = pickFormat(params, String(req.headers.accept ?? ''));

			const route = routes.find((candidate) => candidate.pattern.test(pathname));
			if (!route) {
				throw new HttpError(404, `Unknown endpoint ${pathname}.`);
			}
			if (route.method !== method) {
				throw new HttpError(405, `${pathname} expects ${route.method}, got ${method}.`);
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
			const candidates = Array.isArray(extra.candidates) ? '\n' + candidateTable(extra.candidates as any[], format) : '';
			send(res, status, format, `${message}${candidates}`);
		}
	});

	// Starting a site can take well over a minute (router restart, MySQL
	// warm-up); never let the HTTP layer cut a legitimate request short.
	server.timeout = 0;
	server.requestTimeout = 0;
	server.headersTimeout = 0;
	server.keepAliveTimeout = 0;

	return server;
};

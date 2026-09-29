import * as os from 'os';
import * as path from 'path';

/**
 * Deriving and validating a new site the way Local's "Add Site" dialog does,
 * minus the dialog. Mirrors Local's shared/helpers/format-site-nicename,
 * main/_helpers/sanitizeDomain and renderer/_helpers/validate-site-info.
 */

/** Local's `settings-new-site-defaults`, merged over Local's built-in values. */
export interface NewSiteDefaults {
	sitesPath: string;
	tld: string;
	adminEmail: string;
	siteLanguage: string;
	environment: string;
}

export const BUILT_IN_SITE_DEFAULTS: NewSiteDefaults = {
	sitesPath: '~/Local Sites/',
	tld: '.local',
	adminEmail: 'dev-email@wpengine.local',
	siteLanguage: 'en_US',
	environment: 'flywheel',
};

const HOSTNAME_PATTERN =
	/^(([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])\.)*([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9])$/;

/** "Crazy Name!" -> "crazy-name", identical to Local's formatSiteNicename. */
export const formatSiteNicename = (siteName: string): string =>
	siteName
		.replace(/[^a-z0-9\s-]/gi, '')
		.replace(/\s/gi, '-')
		.replace(/-{2,}/gi, '-')
		.replace(/^-+/gi, '')
		.replace(/-+$/gi, '')
		.toLowerCase();

export const expandHome = (p: string): string =>
	p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;

export const deriveDomain = (nicename: string, tld: string): string =>
	`${nicename}${tld.startsWith('.') ? tld : `.${tld}`}`;

export interface ExistingSite {
	domain: string;
	path: string;
}

export interface ValidateNewSiteInput {
	name: string;
	domain: string;
	sitePath: string;
	existingSites: ExistingSite[];
	sitesPath: string;
	pathHasLocalData: boolean;
	platform: NodeJS.Platform;
}

const normalizePath = (p: string) => {
	const normalized = path.normalize(p);
	return normalized.length > 1 ? normalized.replace(/[\\/]+$/, '') : normalized;
};

/** Returns an error message, or null when the site can be created. */
export const validateNewSite = (input: ValidateNewSiteInput): string | null => {
	const { name, domain, sitePath } = input;
	if (!name.trim()) {
		return 'A site name is required.';
	}
	if (!formatSiteNicename(name)) {
		return `"${name}" contains no letters or digits, so no folder or domain can be derived from it.`;
	}
	if (!HOSTNAME_PATTERN.test(domain)) {
		return `"${domain}" is not a valid domain.`;
	}
	if (input.existingSites.some((site) => site.domain.toLowerCase() === domain.toLowerCase())) {
		return `The domain "${domain}" is already used by another site.`;
	}
	if (normalizePath(sitePath) === normalizePath(input.sitesPath)) {
		return `The site path cannot be the sites directory itself (${input.sitesPath}).`;
	}
	if (input.existingSites.some((site) => normalizePath(site.path) === normalizePath(sitePath))) {
		return `The path "${sitePath}" is already used by another site.`;
	}
	if (input.pathHasLocalData) {
		return `"${sitePath}" already contains a Local site (an app or conf folder).`;
	}
	if (input.platform === 'darwin' && !/^\/(Users|Volumes)\/.+/.test(sitePath)) {
		return `On macOS the site path must be under /Users or /Volumes, got "${sitePath}".`;
	}
	if (input.platform === 'win32') {
		if (sitePath.startsWith('\\\\')) {
			return 'Network drives cannot hold Local sites.';
		}
		if (/^[a-z]:\\?$/i.test(sitePath)) {
			return 'The root of a drive cannot be the site path.';
		}
		if (/^c:/i.test(sitePath) && !/^c:\\users/i.test(sitePath)) {
			return `On Windows a site on C: must live under C:\\Users, got "${sitePath}".`;
		}
	}
	return null;
};

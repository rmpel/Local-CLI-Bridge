/**
 * Version handling for Local's Lightning services.
 *
 * Local stores bare "bin versions" such as `8.3.30`; folders on disk carry a
 * build suffix (`php-8.3.30+1`). Users type either an exact version or a
 * `major.minor` prefix, which resolves to the newest matching patch release.
 * That is exactly what Local's own `getSameOrHighestPatchService()` does when
 * it looks a site's service up, so a site created through the CLI ends up
 * on the same binary the GUI would have picked.
 */

export type ServiceRole = 'php' | 'db' | 'http';

export interface ServiceVersionInfo {
	registered: boolean;
}

/** `{ php: { '8.3.30': {...}, '8.2.29': {...} }, ... }`, newest first. */
export type ServiceCatalog = Record<string, Record<string, ServiceVersionInfo>>;

export const SERVICE_ROLES: Record<string, ServiceRole> = {
	php: 'php',
	mysql: 'db',
	mariadb: 'db',
	apache: 'http',
	nginx: 'http',
};

export const parseVersion = (version: string): number[] =>
	String(version ?? '')
		.split('+')[0]
		.split('.')
		.map((part) => parseInt(part, 10))
		.filter((n) => !Number.isNaN(n));

export const compareVersions = (a: string, b: string): number => {
	const pa = parseVersion(a);
	const pb = parseVersion(b);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) {
			return diff;
		}
	}
	return 0;
};

export const isValidVersionSpec = (spec: string): boolean => /^\d+(\.\d+){0,2}$/.test(spec.trim());

/**
 * Pick a concrete version from `available`. No spec means the newest one; an
 * exact match wins; otherwise the newest version sharing the given
 * `major` or `major.minor` prefix.
 */
export const resolveVersion = (available: string[], spec?: string): string | undefined => {
	const sorted = [...available].sort((a, b) => compareVersions(b, a));
	const wanted = (spec ?? '').trim();
	if (!wanted) {
		return sorted[0];
	}
	if (sorted.includes(wanted)) {
		return wanted;
	}
	const prefix = parseVersion(wanted);
	return sorted.find((candidate) => {
		const parts = parseVersion(candidate);
		return prefix.every((n, i) => parts[i] === n);
	});
};

/** `mysql-8.4` -> { name: 'mysql', version: '8.4' }; `8.4` -> { version: '8.4' }. */
export const parseServiceSpec = (spec: string): { name?: string; version: string } => {
	const match = /^([a-z]+)-(.+)$/i.exec(spec.trim());
	return match ? { name: match[1].toLowerCase(), version: match[2] } : { version: spec.trim() };
};

/**
 * Apache rewrite rules for a WordPress network.
 *
 * WordPress never writes `.htaccess` for a multisite (save_mod_rewrite_rules()
 * bails out when is_multisite()), and Local writes none either. Local's nginx
 * template handles both network types by itself, so this only matters for
 * sites on Apache. The rules come from WordPress core at runtime (see
 * php/network-htaccess.php); these static copies are the fallback and match
 * https://developer.wordpress.org/advanced-administration/server/web-server/httpd/
 */

export type NetworkType = 'subdir' | 'subdomain';

export const MULTISITE_BEGIN = '# BEGIN WordPress Multisite';
export const MULTISITE_END = '# END WordPress Multisite';

export const STATIC_RULES: Record<NetworkType, string> = {
	subdir: `RewriteEngine On
RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
RewriteBase /
RewriteRule ^index\\.php$ - [L]

# add a trailing slash to /wp-admin
RewriteRule ^([_0-9a-zA-Z-]+/)?wp-admin$ $1wp-admin/ [R=301,L]

RewriteCond %{REQUEST_FILENAME} -f [OR]
RewriteCond %{REQUEST_FILENAME} -d
RewriteRule ^ - [L]
RewriteRule ^([_0-9a-zA-Z-]+/)?(wp-(content|admin|includes).*) $2 [L]
RewriteRule ^([_0-9a-zA-Z-]+/)?(.*\\.php)$ $2 [L]
RewriteRule . index.php [L]`,
	subdomain: `RewriteEngine On
RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
RewriteBase /
RewriteRule ^index\\.php$ - [L]

# add a trailing slash to /wp-admin
RewriteRule ^wp-admin$ wp-admin/ [R=301,L]

RewriteCond %{REQUEST_FILENAME} -f [OR]
RewriteCond %{REQUEST_FILENAME} -d
RewriteRule ^ - [L]
RewriteRule ^(wp-(content|admin|includes).*) $1 [L]
RewriteRule ^(.*\\.php)$ $1 [L]
RewriteRule . index.php [L]`,
};

/** Wrap bare rules the way WordPress wraps its own single-site block. */
export const wrapMultisiteBlock = (rules: string, type: NetworkType, source: 'core' | 'static'): string => [
	MULTISITE_BEGIN,
	`# Using ${type === 'subdir' ? 'subfolder' : 'subdomain'} network type, rules from ${source === 'core' ? 'WordPress core' : 'the WordPress documentation'}, written by Local CLI Bridge`,
	'<IfModule mod_rewrite.c>',
	rules.trim(),
	'</IfModule>',
	MULTISITE_END,
	'',
].join('\n');

export type HtaccessAction = 'created' | 'replaced-single' | 'replaced-multisite' | 'unchanged' | 'skipped';

// "# BEGIN WordPress" must not match "# BEGIN WordPress Multisite".
const SINGLE_BLOCK = /# BEGIN WordPress(?![ \w])[^\n]*\r?\n[\s\S]*?# END WordPress(?![ \w])[^\n]*(\r?\n|$)/;
const MULTISITE_BLOCK = /# BEGIN WordPress Multisite[^\n]*\r?\n[\s\S]*?# END WordPress Multisite[^\n]*(\r?\n|$)/;

/**
 * Decide what to do with the site's current `.htaccess` (`null` when absent):
 * create it, replace WordPress's single-site block or an earlier multisite
 * block in place, or leave a hand-written file alone.
 */
export const applyMultisiteBlock = (existing: string | null, block: string): { content: string | null; action: HtaccessAction } => {
	if (existing === null || existing.trim() === '') {
		return { content: block, action: 'created' };
	}
	// Function replacers: the rules contain `$1`/`$2`, which a string
	// replacement would treat as back-references and mangle.
	if (MULTISITE_BLOCK.test(existing)) {
		const content = existing.replace(MULTISITE_BLOCK, () => block);
		return { content, action: content === existing ? 'unchanged' : 'replaced-multisite' };
	}
	if (SINGLE_BLOCK.test(existing)) {
		return { content: existing.replace(SINGLE_BLOCK, () => block), action: 'replaced-single' };
	}
	return { content: null, action: 'skipped' };
};

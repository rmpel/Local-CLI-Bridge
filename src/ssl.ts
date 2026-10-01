/**
 * Trusting a site's SSL certificate from the shell.
 *
 * Local's own "Trust" button hands `security add-trusted-cert` to a background
 * sudo helper (@vscode/sudo-prompt). On modern macOS that context cannot write
 * trust settings: the certificate lands in the System keychain but is never
 * trusted, so browsers keep warning. The same command typed into a Terminal
 * works, which is what the "Trust SSL — macOS Fix" add-on exploits by opening
 * a Terminal window. The CLI has a terminal already, so the bridge hands the
 * client a small script and the client runs it right there: sudo asks for the
 * password inline, nothing new opens.
 *
 * The commands mirror those of Local's `@getflywheel/localcert` per platform,
 * with the `-p ssl` policy from the macOS add-on so the trust actually applies
 * to TLS.
 */
import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const SYSTEM_KEYCHAIN = '/Library/Keychains/System.keychain';

/** A command line as argv; `sudo` says whether it needs administrator rights. */
export interface TrustCommand {
	argv: string[];
	sudo: boolean;
}

export type Platform = 'darwin' | 'linux' | 'win32';

export const shellQuote = (arg: string): string =>
	/^[A-Za-z0-9_\/.:=+@%-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;

export const commandLine = (command: TrustCommand): string =>
	(command.sudo ? 'sudo ' : '') + command.argv.map(shellQuote).join(' ');

/**
 * Where Linux keeps locally added CA certificates, and the command that
 * rebuilds the trust store afterwards. The same probe order as localcert.
 */
export const linuxTrustStore = (exists: (p: string) => boolean = fs.existsSync): { dir: string; refresh: string[] } | null => {
	const candidates: Array<{ dir: string; refresh: string[] }> = [
		{ dir: '/etc/pki/ca-trust/source/anchors/', refresh: ['update-ca-trust', 'extract'] },
		{ dir: '/usr/local/share/ca-certificates/', refresh: ['update-ca-certificates'] },
		{ dir: '/etc/ca-certificates/trust-source/anchors/', refresh: ['trust', 'extract-compat'] },
		{ dir: '/usr/share/pki/trust/anchors/', refresh: ['update-ca-certificates'] },
	];
	return candidates.find((candidate) => exists(candidate.dir)) ?? null;
};

/**
 * NSS databases (Chromium, Firefox on Linux) that get the certificate too,
 * without sudo. Only databases that exist; `certutil` itself is checked by
 * the caller.
 */
export const linuxNssDatabases = (home = os.homedir(), exists: (p: string) => boolean = fs.existsSync, list: (p: string) => string[] = safeReaddir): string[] => {
	const found: string[] = [];
	for (const dir of [path.join(home, '.pki/nssdb'), path.join(home, 'snap/chromium/current/.pki/nssdb'), '/etc/pki/nssdb']) {
		if (exists(path.join(dir, 'cert9.db'))) {
			found.push(`sql:${dir}`);
		}
	}
	const firefox = path.join(home, '.mozilla/firefox');
	for (const profile of list(firefox)) {
		const dir = path.join(firefox, profile);
		if (exists(path.join(dir, 'cert9.db'))) {
			found.push(`sql:${dir}`);
		} else if (exists(path.join(dir, 'cert8.db'))) {
			found.push(`dbm:${dir}`);
		}
	}
	return found;
};

const safeReaddir = (dir: string): string[] => {
	try {
		return fs.readdirSync(dir);
	} catch {
		return [];
	}
};

/** First `binary` on PATH, or null. Local's process PATH, not the shell's, but certutil lives in system folders. */
export const findOnPath = (binary: string, envPath = process.env.PATH ?? ''): string | null => {
	for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
		const candidate = path.join(dir, binary);
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {
			// next
		}
	}
	return null;
};

export interface TrustCommandOptions {
	certutil?: string | null;
	linuxStore?: { dir: string; refresh: string[] } | null;
	nssDatabases?: string[];
}

/** The commands that trust `certPath` system-wide on `platform`, in order. */
export const trustCommands = (platform: Platform, certPath: string, domain: string, options: TrustCommandOptions = {}): TrustCommand[] => {
	switch (platform) {
		case 'darwin':
			return [{ sudo: true, argv: ['security', 'add-trusted-cert', '-d', '-r', 'trustRoot', '-p', 'ssl', '-k', SYSTEM_KEYCHAIN, certPath] }];
		case 'win32':
			// Elevation is the prompt's, not the command's: there is no sudo to prefix.
			return [{ sudo: false, argv: ['certutil', '-addstore', '-f', 'ROOT', path.win32.normalize(certPath)] }];
		case 'linux': {
			const store = options.linuxStore === undefined ? linuxTrustStore() : options.linuxStore;
			if (!store) {
				throw new Error(`No system certificate store was recognised on this Linux; install the certificate by hand: ${certPath}`);
			}
			const commands: TrustCommand[] = [
				{ sudo: true, argv: ['cp', certPath, path.join(store.dir, `${domain}.crt`)] },
				{ sudo: true, argv: store.refresh },
			];
			const certutil = options.certutil === undefined ? null : options.certutil;
			if (certutil) {
				for (const database of options.nssDatabases ?? linuxNssDatabases()) {
					commands.push({ sudo: false, argv: [certutil, '-A', '-d', database, '-t', 'C,,', '-n', `localcert certificate for ${domain}`, '-i', certPath] });
				}
			}
			return commands;
		}
	}
};

/**
 * The script the client runs in its own terminal. Bash, because that is what
 * the client is; it stops at the first failing command so sudo's "Sorry" is
 * not followed by a confusing cascade.
 */
export const buildTrustScript = (domain: string, certPath: string, commands: TrustCommand[]): string => {
	const lines = [
		'#!/bin/bash',
		`# Trusts the Local SSL certificate for ${domain}. Generated by CLI Bridge.`,
		'set -e',
		`CERTFILE=${shellQuote(certPath)}`,
		'if [ ! -e "$CERTFILE" ]; then',
		'\techo "local-cli: certificate not found: $CERTFILE" >&2',
		'\texit 1',
		'fi',
		`echo "Trusting the SSL certificate for ${domain}:"`,
		'echo "  $CERTFILE"',
	];
	if (commands.some((command) => command.sudo)) {
		lines.push('echo "This needs administrator rights; sudo may ask for your password."');
	}
	lines.push('echo');
	for (const command of commands) {
		lines.push(`echo "$ ${commandLine(command).replace(/(["\\$`])/g, '\\$1')}"`);
		lines.push(commandLine(command));
	}
	return lines.join('\n') + '\n';
};

/**
 * SHA-256 of the certificate's DER body, uppercase hex: the format
 * `security find-certificate -Z` prints.
 */
export const certificateFingerprint = (certPath: string): string => {
	const pem = fs.readFileSync(certPath, 'utf8');
	const match = pem.match(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/);
	if (!match) {
		throw new Error(`No PEM certificate found in ${certPath}`);
	}
	return crypto.createHash('sha256').update(Buffer.from(match[1].replace(/\s+/g, ''), 'base64')).digest('hex').toUpperCase();
};

/** macOS: is the certificate present in the System keychain at all? */
export const inSystemKeychain = async (certPath: string): Promise<boolean> => {
	try {
		const fingerprint = certificateFingerprint(certPath);
		const { stdout } = await execFileAsync('security', ['find-certificate', '-a', '-Z', SYSTEM_KEYCHAIN]);
		return new RegExp(`^SHA-256 hash: ${fingerprint}`, 'im').test(stdout);
	} catch {
		return false;
	}
};

/**
 * macOS: does the certificate verify under the SSL policy for its domain?
 * Stricter than Local's own check, which only looks for the certificate in the
 * keychain and therefore reports Local's silently failed trusts as trusted.
 */
export const verifiesForSsl = async (certPath: string, domain: string): Promise<boolean> => {
	try {
		await execFileAsync('security', ['verify-cert', '-c', certPath, '-p', 'ssl', '-n', domain]);
		return true;
	} catch {
		return false;
	}
};

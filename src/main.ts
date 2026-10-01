import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import type * as Local from '@getflywheel/local';
import * as LocalMain from '@getflywheel/local/main';
import { ADDON_NAME, BRIDGE_DIR, INFO_FILE, SOCKET_PATH } from './constants';
import { createBridgeServer, SiteBackend } from './server';

/**
 * CLI Bridge — a tiny HTTP-over-Unix-socket server inside Local's main
 * process, driven by the `local-cli` command in bin/. It replaces the
 * deprecated GraphQL-based local-cli for the day-to-day automation needs:
 * list, start, stop, restart, create and reconfigure sites, and open their
 * front-end, admin, Mailpit and database manager.
 */
export default function (context: LocalMain.AddonMainContext): void {
	const { electron, environment } = context;
	const {
		siteData, siteProcessManager, localLogger, addSite, siteProvisioner, lightningServices,
		adminer, browserManager, wpCli, multiSite, x509Cert, sendIPCEvent,
	} = LocalMain.getServiceContainer().cradle;

	// Local's X509CertService keeps the cert location and generator as statics;
	// the cradle hands out the instance, so reach them through its constructor.
	const X509 = x509Cert.constructor as any;
	const certsDir = path.join(electron.app.getPath('userData'), 'run', 'router', 'nginx', 'certs');

	// The channel the SSL tab's Trust button sends to. The "Trust SSL — macOS
	// Fix" add-on replaces Local's listener there, so emitting on the channel
	// reaches whichever flow the user has installed; a direct trustCert() call
	// would bypass the add-on and run the broken built-in one.
	const TRUST_CHANNEL = 'trustSiteCert';
	const trustViaLocal = (site: Local.Site): Promise<void> => new Promise((resolve, reject) => {
		if (electron.ipcMain.listenerCount(TRUST_CHANNEL) === 0) {
			x509Cert.trustCert(site).then(resolve, reject);
			return;
		}
		const replyChannels = { successReplyChannel: `${ADDON_NAME}:trust-ok`, errorReplyChannel: `${ADDON_NAME}:trust-error` };
		const event = {
			reply: (channel: string, payload: any) => channel === replyChannels.errorReplyChannel
				? reject(new Error(payload?.message ?? 'Local could not trust the certificate.'))
				: resolve(),
		};
		let siteJson: unknown = site;
		try {
			siteJson = JSON.parse(JSON.stringify(site));
		} catch {
			// the listeners can cope with the model itself
		}
		electron.ipcMain.emit(TRUST_CHANNEL, event, replyChannels, siteJson);
	});

	const logger = localLogger.child({ thread: 'main', addon: ADDON_NAME });
	const log = (msg: string) => logger.info(msg);

	const backend: SiteBackend = {
		getSites: () => Object.values(siteData.getSites()) as Local.Site[],
		getSite: (id) => siteData.getSite(id),
		getSiteByDomain: (domain) => siteData.getSiteByProperty('domain', domain),
		getStatus: (site) => siteProcessManager.getSiteStatus(site),
		start: (site) => siteProcessManager.start(site),
		stop: (site) => siteProcessManager.stop(site),
		restart: (site) => siteProcessManager.restart(site),
		getServices: async (role) => {
			const services = await lightningServices.getServices(role as any);
			const catalog: Record<string, Record<string, { registered: boolean }>> = {};
			for (const [name, versions] of Object.entries<any>(services ?? {})) {
				catalog[name] = {};
				for (const [version, service] of Object.entries<any>(versions ?? {})) {
					catalog[name][version] = { registered: service?.registered === true };
				}
			}
			return catalog;
		},
		getNewSiteDefaults: () => {
			try {
				return LocalMain.UserData.get('settings-new-site-defaults', {}) ?? {};
			} catch (err) {
				logger.warn(`Could not read the new-site defaults, using Local's built-ins: ${err?.message ?? err}`);
				return {};
			}
		},
		addSite: (input) => addSite.addSite(input as any),
		swapService: (site, role, serviceName, version) => siteProvisioner.swapService(site, role as any, serviceName, version),
		openInBrowser: (url) => browserManager.openInBrowser(url),
		openDatabase: (site) => adminer.open(site),
		wpCli: async (site, args) => (await wpCli.run(site, args)) ?? '',
		updateSite: (id, patch) => siteData.updateSite(id, patch as any),
		syncSubdomains: (site) => multiSite.syncSubdomains(site),
		localhostRouting: () => !!(global as any).localhostRouting,
		siteCertPath: (site) => {
			try {
				const fromLocal = X509.getSiteCertPath?.(site);
				if (typeof fromLocal === 'string' && fromLocal) {
					return fromLocal;
				}
			} catch {
				// fall through to the known location
			}
			return path.join(certsDir, `${(site as any).domain}.crt`);
		},
		ensureSiteCert: async (site) => {
			if (typeof X509.generateSiteCert === 'function') {
				await X509.generateSiteCert(site);
				return;
			}
			await x509Cert.certificateTrustStatus(site); // generates the certificate when it is missing
		},
		certTrustedByLocal: async (site) => !!(await x509Cert.certificateTrustStatus(site)),
		notifyCertTrusted: (site) => sendIPCEvent('siteCertTrusted', site, true),
		trustViaLocal,
	};

	const addonRoot = path.join(__dirname, '..');
	const addonVersion = (() => {
		try {
			return JSON.parse(fs.readFileSync(path.join(addonRoot, 'package.json'), 'utf8')).version;
		} catch {
			return 'unknown';
		}
	})();

	const server = createBridgeServer(backend, {
		addonVersion,
		localVersion: String(environment.version),
		phpDir: path.join(addonRoot, 'php'),
	}, log);

	const removeSocketArtifacts = () => {
		for (const file of [INFO_FILE, process.platform === 'win32' ? null : SOCKET_PATH]) {
			try {
				if (file && fs.existsSync(file)) {
					fs.unlinkSync(file);
				}
			} catch (err) {
				logger.warn(`Could not remove ${file}: ${err?.message ?? err}`);
			}
		}
	};

	/**
	 * A socket file left behind by a crashed Local would make listen() fail
	 * with EADDRINUSE. Local itself enforces a single running instance, so a
	 * socket nobody answers on is always stale and safe to remove.
	 */
	const clearStaleSocket = (): Promise<void> => new Promise((resolve) => {
		if (process.platform === 'win32' || !fs.existsSync(SOCKET_PATH)) {
			resolve();
			return;
		}
		const probe = net.connect(SOCKET_PATH);
		probe.once('connect', () => {
			probe.destroy();
			logger.warn(`Something is already listening on ${SOCKET_PATH}; leaving it alone.`);
			resolve();
		});
		probe.once('error', () => {
			removeSocketArtifacts();
			resolve();
		});
	});

	const startBridge = async () => {
		fs.mkdirSync(BRIDGE_DIR, { recursive: true, mode: 0o700 });
		await clearStaleSocket();

		server.once('error', (err) => logger.error(`Bridge failed to start on ${SOCKET_PATH}: ${err?.message ?? err}`));
		server.listen(SOCKET_PATH, () => {
			if (process.platform !== 'win32') {
				fs.chmodSync(SOCKET_PATH, 0o600);
			}
			fs.writeFileSync(INFO_FILE, JSON.stringify({
				socketPath: SOCKET_PATH,
				pid: process.pid,
				addonVersion,
				localVersion: String(environment.version),
				startedAt: new Date().toISOString(),
			}, null, '\t'), { mode: 0o600 });
			log(`CLI Bridge v${addonVersion} listening on ${SOCKET_PATH}`);
		});
	};

	electron.app.whenReady().then(startBridge).catch((err) => {
		logger.error(`Bridge could not start: ${err?.stack ?? err}`);
	});

	electron.app.on('will-quit', () => {
		server.close();
		removeSocketArtifacts();
	});
	process.on('exit', removeSocketArtifacts);
}

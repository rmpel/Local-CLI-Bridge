import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import type * as Local from '@getflywheel/local';
import * as LocalMain from '@getflywheel/local/main';
import { ADDON_NAME, BRIDGE_DIR, INFO_FILE, SOCKET_PATH } from './constants';
import { createBridgeServer, SiteBackend } from './server';

/**
 * CLI Bridge — a tiny HTTP-over-Unix-socket server inside Local's main
 * process, driven by the `localwp` command in bin/. It replaces the
 * deprecated GraphQL-based local-cli for the day-to-day automation needs:
 * list, start, stop and restart sites.
 */
export default function (context: LocalMain.AddonMainContext): void {
	const { electron, environment } = context;
	const { siteData, siteProcessManager, localLogger } = LocalMain.getServiceContainer().cradle;

	const logger = localLogger.child({ thread: 'main', addon: ADDON_NAME });
	const log = (msg: string) => logger.info(msg);

	const backend: SiteBackend = {
		getSites: () => Object.values(siteData.getSites()) as Local.Site[],
		getStatus: (site) => siteProcessManager.getSiteStatus(site),
		start: (site) => siteProcessManager.start(site),
		stop: (site) => siteProcessManager.stop(site),
		restart: (site) => siteProcessManager.restart(site),
	};

	const addonVersion = (() => {
		try {
			return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
		} catch {
			return 'unknown';
		}
	})();

	const server = createBridgeServer(backend, { addonVersion, localVersion: String(environment.version) }, log);

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

import * as os from 'os';
import * as path from 'path';

export const ADDON_NAME = 'local-cli-bridge';

/**
 * Where the bridge lives on disk. The CLI (bin/localwp) hardcodes the same
 * defaults, so keep the two in sync when changing anything here.
 *
 * - macOS/Linux: a Unix domain socket in a 0700 directory in the user's home.
 *   File-system permissions are the access control: only the user who runs
 *   Local can talk to the bridge, no token juggling needed.
 * - Windows: a named pipe (Node maps these onto the same `listen(path)` API).
 */
export const BRIDGE_DIR = path.join(os.homedir(), '.local-cli-bridge');
export const INFO_FILE = path.join(BRIDGE_DIR, 'bridge.json');
export const SOCKET_PATH = process.platform === 'win32'
	? '\\\\.\\pipe\\local-cli-bridge'
	: path.join(BRIDGE_DIR, 'bridge.sock');

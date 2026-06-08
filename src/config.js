import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8'));

export const VERSION = pkg.version;
export const USER_AGENT = `cc-proxy/${VERSION}`;

export const DEFAULTS = {
  host: '127.0.0.1',
  port: 55990,
  ccVersion: '0.33.1',
  ccApiBase: 'https://api.commandcode.ai',
  maxTokens: 65536,
};

export function parseArgs(argv) {
  const args = { host: DEFAULTS.host, port: DEFAULTS.port, apiKey: null };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--port':
      case '-p':
        args.port = parseInt(argv[++i], 10);
        break;
      case '--host':
      case '-h':
        args.host = argv[++i];
        break;
      case '--api-key':
      case '-k':
        args.apiKey = argv[++i];
        break;
      case '--version':
      case '-v':
        console.log(`cc-proxy v${VERSION}`);
        process.exit(0);
        break;
      case '--help':
        printHelp();
        process.exit(0);
        break;
    }
  }

  args.port = parseInt(process.env.PORT || String(args.port), 10);
  args.host = process.env.HOST || args.host;
  args.ccVersion = process.env.CC_VERSION || DEFAULTS.ccVersion;

  return args;
}

function printHelp() {
  console.log(`
cc-proxy v${VERSION} — Command Code API proxy

Usage:
  node index.js [options]

Options:
  --port, -p <port>      Server port (default: ${DEFAULTS.port}, env: PORT)
  --host, -h <host>      Bind address (default: ${DEFAULTS.host}, env: HOST)
  --api-key, -k <key>    API key (env: COMMANDCODE_API_KEY, or ~/.commandcode/auth.json)
  --version, -v          Show version
  --help                 Show this help

Examples:
  node index.js
  node index.js --port 8080 --host 0.0.0.0
  node index.js --api-key user_xxxxx
`);
}

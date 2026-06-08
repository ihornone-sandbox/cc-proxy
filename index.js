#!/usr/bin/env node

import { DEFAULTS, VERSION, parseArgs } from './src/config.js';
import { loadApiKey } from './src/auth.js';
import { createServer } from './src/server.js';

const args = parseArgs(process.argv);
const apiKey = loadApiKey(args.apiKey);

if (!apiKey) {
  console.error(`
Error: No Command Code API key found.

Provide it via one of these methods:
  1. --api-key <key> CLI flag
  2. COMMANDCODE_API_KEY environment variable
  3. ~/.commandcode/auth.json (created by "cmd login")
  4. ~/.config/commandcode/auth.json
`);
  process.exit(1);
}

console.error(`cc-proxy v${VERSION}`);
console.error(`Starting proxy on http://${args.host}:${args.port}`);
console.error(`Models: GET  http://${args.host}:${args.port}/v1/models`);
console.error(`Chat:   POST http://${args.host}:${args.port}/v1/chat/completions`);

const app = createServer(apiKey, args.ccVersion, DEFAULTS.ccApiBase);

const server = app.listen(args.port, args.host, () => {
  console.error(`Proxy is ready. Press Ctrl+C to stop.`);
});

function shutdown() {
  console.error('\nShutting down...');
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

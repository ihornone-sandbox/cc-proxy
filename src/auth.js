import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const AUTH_FILE_PATHS = [
  join(homedir(), '.commandcode', 'auth.json'),
  join(homedir(), '.config', 'commandcode', 'auth.json'),
];

export function loadApiKey(cliKey) {
  if (cliKey) return cliKey;
  if (process.env.COMMANDCODE_API_KEY) return process.env.COMMANDCODE_API_KEY;
  for (const p of AUTH_FILE_PATHS) {
    try {
      if (existsSync(p)) {
        const data = JSON.parse(readFileSync(p, 'utf-8'));
        return data.apiKey || data.key || null;
      }
    } catch {}
  }
  return null;
}

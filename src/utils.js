export function log(level, message) {
  const ts = new Date().toISOString();
  console.error(`[${ts}] [${level}] ${message}`);
}

export function info(message) { log('INFO', message); }
export function warn(message) { log('WARN', message); }
export function error(message) { log('ERROR', message); }
export function debug(message) { log('DEBUG', message); }

export async function withRetry(fn, retries = 3, baseDelay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, i)));
    }
  }
}

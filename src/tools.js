import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, globSync, statSync } from 'fs';
import { resolve, relative, sep } from 'path';

const MAX_OUTPUT_LENGTH = 100000;

const TOOLS = [
  {
    name: 'bash',
    description: 'Execute a shell command',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        workdir: { type: 'string' },
        timeout: { type: 'number' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read',
    description: 'Read a file or directory',
    input_schema: {
      type: 'object',
      properties: {
        filePath: { type: 'string' },
        offset: { type: 'integer' },
        limit: { type: 'integer' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'write',
    description: 'Write content to a file',
    input_schema: {
      type: 'object',
      properties: {
        filePath: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['filePath', 'content'],
    },
  },
  {
    name: 'edit',
    description: 'Find and replace text in a file',
    input_schema: {
      type: 'object',
      properties: {
        filePath: { type: 'string' },
        oldString: { type: 'string' },
        newString: { type: 'string' },
        replaceAll: { type: 'boolean' },
      },
      required: ['filePath', 'oldString', 'newString'],
    },
  },
  {
    name: 'glob',
    description: 'Find files matching a pattern',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description: 'Search for text in files',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
        include: { type: 'string' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'webfetch',
    description: 'Fetch content from a URL',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        format: { type: 'string', enum: ['text', 'markdown'] },
        timeout: { type: 'number' },
      },
      required: ['url'],
    },
  },
  {
    name: 'websearch',
    description: 'Search the web for information',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        numResults: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    name: 'apply_patch',
    description: 'Apply patch to create/edit/delete files',
    input_schema: {
      type: 'object',
      properties: {
        patchText: { type: 'string' },
      },
      required: ['patchText'],
    },
  },
];

export function getDefaultTools() {
  return TOOLS;
}

export async function executeTool(name, args, workingDir) {
  const parsed = typeof args === 'string' ? safeParse(args) : (args || {});
  if (!parsed) return { error: 'Invalid arguments: not valid JSON' };

  try {
    switch (name) {
      case 'bash':
      case 'execute_command':
        return await execBash(parsed);
      case 'read':
      case 'read_file':
        return await readFile_(parsed);
      case 'write':
      case 'write_file':
        return await writeFile_(parsed);
      case 'edit':
      case 'edit_file':
        return await editFile_(parsed);
      case 'glob':
        return await globFiles(parsed);
      case 'grep':
        return await grepFiles(parsed);
      case 'webfetch':
      case 'fetch':
        return await webFetch(parsed);
      case 'websearch':
        return await webSearch(parsed);
      case 'apply_patch':
        return await applyPatch(parsed);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err.message };
  }
}

function safeParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function execBash(args) {
  const command = args.command || args.cmd;
  if (!command) return { error: 'No command provided' };

  const cwd = args.workdir || process.cwd();
  const timeout = Math.min(args.timeout || 30000, 300000);

  try {
    const output = execSync(command, {
      cwd,
      timeout,
      maxBuffer: MAX_OUTPUT_LENGTH,
      encoding: 'utf-8',
      windowsHide: true,
    });
    return { stdout: output, stderr: '' };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || err.message,
      exitCode: err.status ?? 1,
    };
  }
}

function readFile_(args) {
  const filePath = resolve(args.filePath || args.file_path || args.path || args.file);

  try {
    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      const entries = execSync(`ls -la "${filePath}"`, { encoding: 'utf-8', maxBuffer: MAX_OUTPUT_LENGTH })
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);
      return { content: entries.join('\n') };
    }
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const offset = args.offset || 1;
    const limit = args.limit || 2000;

    const sliced = lines.slice(offset - 1, offset - 1 + limit);
    if (sliced.length === 0) return { content: '' };

    let output = sliced.join('\n');
    if (lines.length > offset - 1 + limit) {
      output += `\n... (${lines.length - (offset - 1 + limit)} more lines)`;
    }
    return { content: output };
  } catch (err) {
    if (err.code === 'ENOENT') return { error: `File not found: ${filePath}` };
    return { error: err.message };
  }
}

function writeFile_(args) {
  const filePath = resolve(args.filePath || args.file_path || args.path || args.file);
  const content = args.content || '';
  writeFileSync(filePath, content, 'utf-8');
  return { success: true, file_path: filePath };
}

function editFile_(args) {
  const filePath = resolve(args.filePath || args.file_path || args.path || args.file);
  const oldStr = args.oldString || args.old_string || args.old;
  const newStr = args.newString || args.new_string || args.new;

  if (!existsSync(filePath)) {
    return { error: `File not found: ${filePath}` };
  }

  const content = readFileSync(filePath, 'utf-8');

  if (args.replaceAll) {
    if (!content.includes(oldStr)) {
      return { error: `Could not find oldString in file` };
    }
    const newContent = content.split(oldStr).join(newStr);
    writeFileSync(filePath, newContent, 'utf-8');
    const count = (content.match(new RegExp(escapeRegex(oldStr), 'g')) || []).length;
    return { success: true, file_path: filePath, replacements: count };
  }

  const idx = content.indexOf(oldStr);
  if (idx === -1) {
    return { error: `Could not find oldString in file` };
  }
  const newContent = content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
  writeFileSync(filePath, newContent, 'utf-8');
  return { success: true, file_path: filePath };
}

function globFiles(args) {
  const basePath = args.path || process.cwd();
  const pattern = args.pattern;
  if (!pattern) return { error: 'No pattern provided' };

  try {
    const matches = globSync(pattern, { cwd: basePath });
    const results = matches
      .map(f => {
        const full = resolve(basePath, f);
        try {
          const s = statSync(full);
          return { path: f.replace(/\\/g, '/'), type: s.isDirectory() ? 'directory' : 'file', mtime: s.mtimeMs };
        } catch {
          return { path: f.replace(/\\/g, '/'), type: 'unknown' };
        }
      })
      .sort((a, b) => ((b.mtime || 0) - (a.mtime || 0)));

    return { files: results.map(r => r.path) };
  } catch (err) {
    return { error: err.message };
  }
}

async function grepFiles(args) {
  const basePath = resolve(args.path || process.cwd());
  const pattern = args.pattern;
  if (!pattern) return { error: 'No pattern provided' };

  try {
    new RegExp(pattern);
  } catch {
    return { error: 'Invalid regex pattern' };
  }

  const include = args.include;
  const results = [];

  try {
    let cmd = `rg -n --no-heading "${pattern.replace(/"/g, '\\"')}" "${basePath}"`;
    if (include) {
      cmd += ` -g "${include}"`;
    }
    cmd += ' 2>/dev/null || true';

    const output = execSync(cmd, {
      encoding: 'utf-8',
      maxBuffer: MAX_OUTPUT_LENGTH,
      timeout: 10000,
    });

    const lines = output.trim().split('\n').filter(Boolean);
    const maxResults = 100;
    for (const line of lines.slice(0, maxResults)) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const filePath = line.slice(0, idx);
      const rest = line.slice(idx + 1);
      const idx2 = rest.indexOf(':');
      if (idx2 === -1) {
        results.push({ file: relative(process.cwd(), resolve(basePath, filePath)).replace(/\\/g, '/') });
      } else {
        results.push({
          file: relative(process.cwd(), resolve(basePath, filePath)).replace(/\\/g, '/'),
          line: parseInt(rest.slice(0, idx2), 10),
          match: rest.slice(idx2 + 1).trim(),
        });
      }
    }

    if (lines.length > maxResults) {
      return { matches: results, truncated: true, total_matches: lines.length };
    }
    return { matches: results };
  } catch {
    return { error: 'grep failed. ripgrep (rg) might not be installed.' };
  }
}

async function webFetch(args) {
  const url = args.url;
  if (!url) return { error: 'No URL provided' };

  try {
    const timeout = Math.min((args.timeout || 15) * 1000, 120000);
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeout),
      headers: { 'User-Agent': 'cc-proxy/1.0' },
    });
    if (!res.ok) {
      return { error: `HTTP ${res.status}: ${res.statusText}` };
    }
    const text = await res.text();
    const maxLen = 50000;
    return {
      url,
      status: res.status,
      content: text.length > maxLen ? text.slice(0, maxLen) + `\n\n... (truncated, ${text.length} total chars)` : text,
    };
  } catch (err) {
    if (err.name === 'TimeoutError') return { error: 'Request timed out' };
    return { error: err.message };
  }
}

async function webSearch(args) {
  const query = args.query;
  if (!query) return { error: 'No query provided' };

  const numResults = Math.min(args.numResults || 5, 10);

  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; cc-proxy/1.0)' },
    });
    const html = await res.text();

    const results = [];
    const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gs;
    let match;
    let count = 0;

    while ((match = resultRegex.exec(html)) !== null && count < numResults) {
      let href = match[1];
      if (href.startsWith('//')) href = 'https:' + href;
      results.push({
        title: match[2].replace(/<[^>]+>/g, ''),
        url: href,
        snippet: match[3].replace(/<[^>]+>/g, '').trim(),
      });
      count++;
    }

    if (results.length === 0) {
      const simpleRegex = /<a[^>]*href="(https?:\/\/[^"]*)"[^>]*>(.*?)<\/a>/gs;
      while ((match = simpleRegex.exec(html)) !== null && count < numResults) {
        results.push({
          url: match[1],
          title: match[2].replace(/<[^>]+>/g, ''),
          snippet: '',
        });
        count++;
      }
    }

    if (results.length === 0) {
      return { error: 'No results found', results: [] };
    }
    return { results };
  } catch (err) {
    if (err.name === 'TimeoutError') return { error: 'Search request timed out' };
    return { error: `Search failed: ${err.message}` };
  }
}

function applyPatch(args) {
  const patchText = args.patchText || args.patch;
  if (!patchText) return { error: 'No patch text provided' };

  const results = [];

  const addRegex = /\*\*\*\s*Add\s+File:\s*(.+?)(?:\r?\n|\r)([\s\S]*?)(?=(?:\r?\n|\r)\*\*\*|\s*$)/g;
  const deleteRegex = /\*\*\*\s*Delete\s+File:\s*(.+?)(?:\r?\n|\r|$)/g;
  const updateRegex = /\*\*\*\s*Update\s+File:\s*(.+?)(?:\r?\n|\r)([\s\S]*?)(?=(?:\r?\n|\r)\*\*\*|\s*$)/g;
  const simpleUpdateRegex = /^--- (.+?)\n\+\+\+ .+?\n@@ .+? @@\n([\s\S]*?)(?=\n--- |\n\*\*\*|$)/gm;

  let match;

  while ((match = addRegex.exec(patchText)) !== null) {
    const filePath = resolve(match[1].trim());
    const content = match[2].trim();
    try {
      writeFileSync(filePath, content + '\n', 'utf-8');
      results.push({ operation: 'add', file_path: filePath, success: true });
    } catch (err) {
      results.push({ operation: 'add', file_path: filePath, success: false, error: err.message });
    }
  }

  while ((match = deleteRegex.exec(patchText)) !== null) {
    const filePath = resolve(match[1].trim());
    try {
      if (existsSync(filePath)) {
        writeFileSync(filePath, '', 'utf-8');
        results.push({ operation: 'delete', file_path: filePath, success: true });
      } else {
        results.push({ operation: 'delete', file_path: filePath, success: false, error: 'File not found' });
      }
    } catch (err) {
      results.push({ operation: 'delete', file_path: filePath, success: false, error: err.message });
    }
  }

  while ((match = updateRegex.exec(patchText)) !== null) {
    const filePath = resolve(match[1].trim());
    const patchContent = match[2];
    try {
      const oldNewRegex = /^\- (.+)\n\+ (.+)/gm;
      let pMatch;
      let current = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
      while ((pMatch = oldNewRegex.exec(patchContent)) !== null) {
        const idx = current.indexOf(pMatch[1]);
        if (idx !== -1) {
          current = current.slice(0, idx) + pMatch[2] + current.slice(idx + pMatch[1].length);
        }
      }
      writeFileSync(filePath, current, 'utf-8');
      results.push({ operation: 'update', file_path: filePath, success: true });
    } catch (err) {
      results.push({ operation: 'update', file_path: filePath, success: false, error: err.message });
    }
  }

  return { results };
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

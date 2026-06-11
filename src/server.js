import express from 'express';
import cors from 'cors';
import { execSync } from 'child_process';
import { toCCMessages, toCCTools, convertToolChoice } from './translate.js';
import { info, warn, error as logError, debug, withRetry } from './utils.js';

export function createServer(apiKey, ccVersion, ccApiBase) {

  const modelCache = { list: [], fetchedAt: 0 };

  let cachedConfig = null;
  let configCachedAt = 0;

  function buildCCConfig() {
    const now = new Date();
    const cwd = process.cwd();

    if (cachedConfig && Date.now() - configCachedAt < 5000) {
      cachedConfig.date = now.toISOString().slice(0, 10);
      return cachedConfig;
    }

    let isGitRepo = false;
    let currentBranch = '';
    let mainBranch = '';
    let gitStatus = '';
    let recentCommits = [];

    try {
      const inWorkTree = execSync('git rev-parse --is-inside-work-tree', { cwd, encoding: 'utf-8', stdio: 'pipe', timeout: 2000 }).trim();
      if (inWorkTree === 'true') {
        isGitRepo = true;
        currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8', stdio: 'pipe', timeout: 2000 }).trim();
        try {
          const originHead = execSync('git symbolic-ref refs/remotes/origin/HEAD', { cwd, encoding: 'utf-8', stdio: 'pipe', timeout: 2000 }).trim();
          mainBranch = originHead.replace('refs/remotes/origin/', '');
        } catch {
          mainBranch = 'main';
        }
        gitStatus = execSync('git status --short', { cwd, encoding: 'utf-8', stdio: 'pipe', timeout: 2000 }).trim();
        const logOutput = execSync('git log --oneline -10', { cwd, encoding: 'utf-8', stdio: 'pipe', timeout: 2000 }).trim();
        recentCommits = logOutput ? logOutput.split('\n').filter(Boolean) : [];
      }
    } catch {}

    cachedConfig = {
      workingDir: cwd,
      date: now.toISOString().slice(0, 10),
      environment: 'terminal',
      os: process.platform,
      nodeVersion: process.version,
      structure: [],
      isGitRepo,
      currentBranch,
      mainBranch,
      gitStatus,
      recentCommits,
    };
    configCachedAt = Date.now();
    return cachedConfig;
  }

  async function fetchModels() {
    if (Date.now() - modelCache.fetchedAt < 60000) return modelCache.list;
    try {
      const res = await withRetry(() => fetch(`${ccApiBase}/provider/v1/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000),
      }), 2, 500);
      if (res.ok) {
        const data = await res.json();
        modelCache.list = data.data || [];
        modelCache.fetchedAt = Date.now();
      }
    } catch (err) {
      warn(`Failed to fetch models: ${err.message}`);
    }
    return modelCache.list;
  }

  const CONNECT_TIMEOUT = 60000;
  const CHUNK_TIMEOUT = 60000;
  const MAX_STREAM_DURATION = 600000;

  function readWithTimeout(reader, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reader.cancel();
        reject(new Error('Chunk timeout: no data received for ' + (timeoutMs / 1000) + 's'));
      }, timeoutMs);
      reader.read().then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
    });
  }

  function streamFromCC(body, onDelta, onToolCall, onFinish, onError) {
    let cancelled = false;
    let streamStarted = Date.now();
    let finished = false;

    (async () => {
      try {
        const res = await withRetry(async () => {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), CONNECT_TIMEOUT);
          try {
            return await fetch(`${ccApiBase}/alpha/generate`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'x-command-code-version': ccVersion,
                'x-cli-environment': 'production',
              },
              body: JSON.stringify(body),
              signal: ctrl.signal,
            });
          } finally {
            clearTimeout(t);
          }
        }, 2, 1000);

        if (!res.ok) {
          const errText = await res.text();
          warn(`CC API error ${res.status}: ${errText.slice(0, 300)}`);
          let detail;
          try { const j = JSON.parse(errText); detail = j.error?.message || j.message; } catch { detail = errText.slice(0, 200); }
          onError(new Error(`CC API error (${res.status}): ${detail || errText.slice(0, 200)}`));
          return;
        }

        debug('CC API connected, starting stream read');

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let currentToolCall = null;
        let collectedUsage = null;
        let toolCallIndex = 0;

        while (true) {
          if (cancelled) return;
          if (Date.now() - streamStarted > MAX_STREAM_DURATION) {
            throw new Error('Stream exceeded maximum duration of ' + (MAX_STREAM_DURATION / 1000) + 's');
          }

          const { done, value } = await readWithTimeout(reader, CHUNK_TIMEOUT);
          if (done) { debug('Stream read complete (done=true)'); break; }
          if (!value || value.length === 0) continue;
          const chunkText = decoder.decode(value, { stream: true });
          debug(`Stream chunk received: ${value.length} bytes`);

          buf += chunkText;
          const lines = buf.split('\n');
          buf = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim() || cancelled) continue;
            try {
              const ev = JSON.parse(line);

              if (ev.type === 'text-delta') {
                onDelta(ev.text || '');
              } else if (ev.type === 'reasoning-delta') {
                if (ev.text) onDelta(ev.text);
              } else if (ev.type === 'tool-input-start') {
                currentToolCall = { id: ev.id || `call_${Date.now()}_${++toolCallIndex}`, name: ev.toolName || '', arguments: '' };
                debug(`Tool input start: ${ev.toolName}`);
              } else if (ev.type === 'tool-input-delta') {
                if (currentToolCall) currentToolCall.arguments += ev.delta || '';
              } else if (ev.type === 'tool-call') {
                const rawArgs = typeof ev.arguments === 'string' ? ev.arguments
                  : ev.arguments !== undefined && ev.arguments !== null ? JSON.stringify(ev.arguments)
                  : currentToolCall?.arguments || '';
                const tc = {
                  id: ev.id || currentToolCall?.id || '',
                  name: ev.name || currentToolCall?.name || '',
                  arguments: rawArgs,
                };
                currentToolCall = null;
                debug(`Tool call: ${tc.name}`);
                onToolCall(tc);
              } else if (ev.type === 'finish-step') {
                if (currentToolCall) {
                  debug(`Finish-step with pending tool call: ${currentToolCall.name}`);
                  onToolCall(currentToolCall);
                  currentToolCall = null;
                }
                if (ev.usage && typeof ev.usage === 'object') {
                  collectedUsage = {
                    prompt_tokens: ev.usage.inputTokens || ev.usage.totalInputTokens || 0,
                    completion_tokens: ev.usage.outputTokens || ev.usage.totalOutputTokens || 0,
                    total_tokens: ev.usage.totalTokens || 0,
                  };
                }
              } else if (ev.type === 'finish') {
                const total = ev.totalUsage || collectedUsage;
                if (total && typeof total === 'object') {
                  collectedUsage = {
                    prompt_tokens: Math.max(0, total.inputTokens || total.totalInputTokens || 0),
                    completion_tokens: Math.max(0, total.outputTokens || total.totalOutputTokens || 0),
                    total_tokens: Math.max(0, total.totalTokens || 0),
                  };
                } else {
                  collectedUsage = collectedUsage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
                }
                debug(`Stream finish: reason=${ev.finishReason || 'stop'} tokens=${collectedUsage.total_tokens}`);
                finished = true;
                onFinish(ev.finishReason || 'stop', collectedUsage);
              } else if (ev.type === 'error') {
                const errMsg = ev.error?.message || ev.message || 'Unknown CC API error';
                const statusCode = ev.error?.statusCode || ev.statusCode || 500;
                warn(`CC API stream error: ${errMsg} (${statusCode})`);
                onError(new Error(`CC API error: ${errMsg}`));
              }
            } catch {
              debug(`Failed to parse stream line: ${line.slice(0, 100)}`);
            }
          }
        }
        if (!finished && !cancelled) {
          debug('Stream ended without finish event');
          onError(new Error('Stream ended without finish event'));
        }
      } catch (err) {
        if (!cancelled) {
          debug(`Stream error: ${err.message}`);
          onError(err);
        }
      }
    })();

    return () => { cancelled = true; };
  }

  function bufferFromCC(body) {
    return new Promise((resolve, reject) => {
      let text = '';
      const toolCalls = [];
      let usage = null;

      streamFromCC(body,
        (delta) => { text += delta; },
        (tc) => { toolCalls.push(tc); },
        (reason, u) => {
          usage = u;
          resolve({ text, toolCalls, usage, finishReason: reason });
        },
        (err) => { reject(err); },
      );
    });
  }

  const DEFAULT_TOOLS = [
    { name: 'bash', description: 'Execute a shell command', input_schema: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' }, workdir: { type: 'string' }, timeout: { type: 'number' } }, required: ['command'] } },
    { name: 'read', description: 'Read a file or directory from the local filesystem', input_schema: { type: 'object', properties: { filePath: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, required: ['filePath'] } },
    { name: 'write', description: 'Write content to a file (overwrite if exists)', input_schema: { type: 'object', properties: { filePath: { type: 'string' }, content: { type: 'string' } }, required: ['filePath', 'content'] } },
    { name: 'edit', description: 'Find and replace text in a file', input_schema: { type: 'object', properties: { filePath: { type: 'string' }, oldString: { type: 'string' }, newString: { type: 'string' }, replaceAll: { type: 'boolean' } }, required: ['filePath', 'oldString', 'newString'] } },
    { name: 'glob', description: 'Find files matching a glob pattern', input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
    { name: 'grep', description: 'Search file contents using regular expressions', input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, include: { type: 'string' } }, required: ['pattern'] } },
    { name: 'webfetch', description: 'Fetch content from a URL', input_schema: { type: 'object', properties: { url: { type: 'string' }, format: { type: 'string' }, timeout: { type: 'number' } }, required: ['url'] } },
    { name: 'websearch', description: 'Search the web for information', input_schema: { type: 'object', properties: { query: { type: 'string' }, numResults: { type: 'number' } }, required: ['query'] } },
    { name: 'apply_patch', description: 'Apply a patch to create, edit, or delete one or more files', input_schema: { type: 'object', properties: { patchText: { type: 'string' } }, required: ['patchText'] } },
  ];

  function buildCCBody(model, messages, tools, toolChoice, maxTokens, temperature, responseFormat) {
    const { system, messages: ccMessages } = toCCMessages(messages);
    const clientTools = toCCTools(tools);
    const seen = new Set();
    const mergedTools = [...DEFAULT_TOOLS, ...clientTools].filter(t => {
      if (seen.has(t.name)) return false;
      seen.add(t.name);
      return true;
    });
    debug(`Sending ${mergedTools.length} tools to CC API: ${mergedTools.map(t => t.name).join(', ')}`);
    return {
      config: buildCCConfig(),
      memory: '',
      taste: '',
      skills: null,
      permissionMode: 'auto-accept',
      params: {
        model,
        messages: ccMessages,
        tools: mergedTools,
        system,
        max_tokens: maxTokens || 64000,
        temperature: temperature ?? undefined,
        tool_choice: convertToolChoice(toolChoice),
        response_format: responseFormat,
        stream: true,
      },
    };
  }

  async function handleStream(req, res, model, messages, tools, toolChoice, maxTokens, temperature, responseFormat) {
    let cancelled = false;
    let cancelStream = null;
    const reqId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    req.on('close', () => {
      // req.close fires after body is consumed, not just on client disconnect.
      // Use res.close instead to detect actual client disconnect.
    });
    res.on('close', () => { cancelled = true; if (cancelStream) cancelStream(); });

    const id = 'chatcmpl-' + Date.now();
    const created = Math.floor(Date.now() / 1000);
    let roleSent = false;
    let finishReason = 'stop';
    let toolIndex = 0;

    const send = (data) => {
      if (cancelled) return;
      try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
    };

    const sendRole = () => {
      if (roleSent) return;
      roleSent = true;
      send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
    };

    const end = () => {
      send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });
      try { res.write('data: [DONE]\n\n'); } catch {}
      try { res.end(); } catch {}
      cancelled = true;
    };

    const ccBody = buildCCBody(model, messages, tools, toolChoice, maxTokens, temperature, responseFormat);

    const streamTimeout = setTimeout(() => {
      if (cancelStream) cancelStream();
      cancelled = true;
      warn(`[${reqId}] Stream request timed out after 5 minutes`);
      try {
        send({ error: { message: 'Request timed out', type: 'server_error' } });
        end();
      } catch {}
    }, 300000);

    try {
      await new Promise((resolve, reject) => {
        let text = '';
        const toolCalls = [];
        let settled = false;

        cancelStream = streamFromCC(ccBody,
          (delta) => {
            if (cancelled) return;
            sendRole();
            text += delta;
            send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] });
          },
          (tc) => {
            if (cancelled) return;
            sendRole();
            const idx = toolIndex++;
            const openAITc = {
              id: tc.id,
              index: idx,
              type: 'function',
              function: { name: tc.name, arguments: tc.arguments },
            };
            toolCalls.push(openAITc);
            debug(`[${reqId}] Tool call: ${tc.name}`);
            send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { tool_calls: [openAITc] }, finish_reason: null }] });
          },
          (reason, u) => {
            if (cancelled || settled) return;
            settled = true;
            clearTimeout(streamTimeout);
            finishReason = reason === 'tool-calls' ? 'tool_calls' : (reason || 'stop');
            debug(`[${reqId}] Stream finished: reason=${finishReason} text=${text.length}chars toolCalls=${toolCalls.length} tokens=${u?.total_tokens || 0}`);
            if (toolCalls.length === 0) debug(`Model text response (first 200): ${text.slice(0, 200)}`);
            resolve();
          },
          (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(streamTimeout);
            reject(err);
          },
        );
      });
      end();
      clearTimeout(streamTimeout);
    } catch (err) {
      clearTimeout(streamTimeout);
      if (cancelled) return;
      warn(`[${reqId}] Stream error: ${err.message}`);
      try {
        send({ error: { message: err.message, type: 'server_error' } });
        end();
      } catch {}
    }
  }

  async function handleNonStream(model, messages, tools, toolChoice, maxTokens, temperature, responseFormat) {
    const ccBody = buildCCBody(model, messages, tools, toolChoice, maxTokens, temperature, responseFormat);
    const result = await bufferFromCC(ccBody);

    const hasToolCalls = result.toolCalls && result.toolCalls.length > 0;
    const formattedCalls = hasToolCalls ? result.toolCalls.map((tc, i) => ({
      id: tc.id, index: i, type: 'function',
      function: { name: tc.name, arguments: tc.arguments },
    })) : undefined;

    const message = { role: 'assistant', content: result.text || null };
    if (formattedCalls) message.tool_calls = formattedCalls;

    return {
      message,
      finish_reason: hasToolCalls && !result.text ? 'tool_calls' : (result.finishReason || 'stop'),
      usage: result.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: process.env.MAX_BODY_SIZE || '50mb' }));

  app.get('/health', async (_req, res) => {
    try {
      const ccRes = await withRetry(() => fetch(`${ccApiBase}/provider/v1/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
      }), 1, 500);
      res.json({ status: 'ok', cc_api: ccRes.ok ? 'ok' : 'error', cc_status: ccRes.status });
    } catch (err) {
      res.status(502).json({ status: 'error', cc_api: 'unreachable', detail: err.message });
    }
  });

  app.get('/v1/models', async (_req, res) => {
    const models = await fetchModels();
    res.json({ object: 'list', data: models });
  });

  app.post('/v1/chat/completions', async (req, res) => {
    const { model, messages, stream, max_tokens, temperature, tools, tool_choice, response_format } = req.body;

    if (!model || !messages) {
      return res.status(400).json({
        error: { message: 'model and messages are required', type: 'invalid_request_error' },
      });
    }

    info(`[${Date.now().toString(36)}] Chat: model=${model} stream=${!!stream} tools=${tools?.length || 0} messages=${messages.length}`);

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      await handleStream(req, res, model, messages, tools, tool_choice, max_tokens, temperature, response_format);
    } else {
      try {
        const result = await handleNonStream(model, messages, tools, tool_choice, max_tokens, temperature, response_format);
        res.json({
          id: 'chatcmpl-' + Date.now(),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message: result.message, finish_reason: result.finish_reason }],
          usage: result.usage,
        });
      } catch (err) {
        logError(`Chat error: ${err.message}`);
        res.status(502).json({
          error: { message: err.message, type: 'server_error' },
        });
      }
    }
  });

  return app;
}

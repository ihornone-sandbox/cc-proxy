import express from 'express';
import cors from 'cors';
import { toCCMessages, toCCTools, buildCCConfig, convertToolChoice } from './translate.js';
import { getDefaultTools, executeTool } from './tools.js';

const MAX_TOOL_ITERATIONS = 20;

function mergeTools(clientTools) {
  const defaults = getDefaultTools();
  const all = [...defaults, ...(clientTools ? toCCTools(clientTools) : [])];
  const seen = new Set();
  return all.filter(t => {
    if (seen.has(t.name)) return false;
    seen.add(t.name);
    return true;
  });
}

function safeParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

export function createServer(apiKey, ccVersion, ccApiBase) {

  const modelCache = { list: [], fetchedAt: 0 };

  async function fetchModels() {
    if (Date.now() - modelCache.fetchedAt < 60000) return modelCache.list;
    try {
      const res = await fetch(`${ccApiBase}/provider/v1/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.ok) {
        const data = await res.json();
        modelCache.list = data.data || [];
        modelCache.fetchedAt = Date.now();
      }
    } catch {}
    return modelCache.list;
  }

  function streamFromCC(body, onDelta, onToolCall, onFinish, onError) {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`${ccApiBase}/alpha/generate`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'x-command-code-version': ccVersion,
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const errText = await res.text();
          
          onError(new Error(`Command Code API error (${res.status}): ${errText}`));
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let currentToolCall = null;
        let collectedUsage = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim() || cancelled) continue;
            try {
              const ev = JSON.parse(line);

              if (ev.type === 'text-delta') {
                onDelta(ev.text || '');
              } else if (ev.type === 'tool-input-start') {
                currentToolCall = { id: ev.id || '', name: ev.toolName || '', arguments: '' };
              } else if (ev.type === 'tool-input-delta') {
                if (currentToolCall) currentToolCall.arguments += ev.delta || '';
              } else if (ev.type === 'tool-call') {
                const tc = {
                  id: ev.id || currentToolCall?.id || '',
                  name: ev.name || currentToolCall?.name || '',
                  arguments: typeof ev.arguments === 'string' ? ev.arguments : JSON.stringify(ev.arguments || currentToolCall?.arguments || ''),
                };
                currentToolCall = null;
                onToolCall(tc);
              } else if (ev.type === 'finish-step') {
                if (currentToolCall) {
                  onToolCall(currentToolCall);
                  currentToolCall = null;
                }
                if (ev.usage) {
                  collectedUsage = {
                    prompt_tokens: ev.usage.inputTokens || ev.usage.totalInputTokens || 0,
                    completion_tokens: ev.usage.outputTokens || ev.usage.totalOutputTokens || 0,
                    total_tokens: ev.usage.totalTokens || 0,
                  };
                }
              } else if (ev.type === 'finish') {
                const total = ev.totalUsage || collectedUsage;
                if (total) {
                  collectedUsage = {
                    prompt_tokens: total.inputTokens || total.totalInputTokens || 0,
                    completion_tokens: total.outputTokens || total.totalOutputTokens || 0,
                    total_tokens: total.totalTokens || 0,
                  };
                }
                onFinish(ev.finishReason || 'stop', collectedUsage);
              }
            } catch {}
          }
        }
      } catch (err) {
        if (!cancelled) onError(err);
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

  async function runToolLoop(messages, model, tools, toolChoice, maxTokens, temperature) {
    messages = [...messages];
    const mergedTools = mergeTools(tools);
    let fullText = '';
    let finalUsage = null;

    for (let round = 0; round < MAX_TOOL_ITERATIONS; round++) {
      const { system, messages: ccMessages } = toCCMessages(messages);

      const ccBody = {
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
          max_tokens: maxTokens || 65536,
          temperature: temperature ?? undefined,
          tool_choice: convertToolChoice(toolChoice),
          stream: true,
        },
      };

      let result;
      try {
        result = await bufferFromCC(ccBody);
      } catch (err) {
        throw err;
      }

      fullText += result.text;
      finalUsage = result.usage || finalUsage;

      if (result.toolCalls.length === 0) {
        return { content: fullText, usage: finalUsage };
      }

      const assistantMsg = {
        role: 'assistant',
        content: result.text,
        tool_calls: result.toolCalls.map(tc => ({
          id: tc.id, type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
      messages.push(assistantMsg);

      for (const tc of result.toolCalls) {
        const parsed = safeParse(tc.arguments) || {};
        const output = await executeTool(tc.name, parsed, process.cwd());
        const outputStr = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: outputStr });
      }
    }

    throw new Error('Tool execution exceeded maximum iterations');
  }

  async function streamToolLoop(messages, model, tools, toolChoice, maxTokens, temperature, res) {
    messages = [...messages];
    const mergedTools = mergeTools(tools);

    const id = 'chatcmpl-' + Date.now();
    const created = Math.floor(Date.now() / 1000);
    let roleSent = false;

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    const sendRole = () => {
      if (roleSent) return;
      roleSent = true;
      send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
    };

    for (let round = 0; round < MAX_TOOL_ITERATIONS; round++) {
      const { system, messages: ccMessages } = toCCMessages(messages);

      const ccBody = {
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
          max_tokens: maxTokens || 65536,
          temperature: temperature ?? undefined,
          tool_choice: convertToolChoice(toolChoice),
          stream: true,
        },
      };

      const roundResult = await new Promise((resolve, reject) => {
        let text = '';
        const toolCalls = [];
        let usage = null;

        streamFromCC(ccBody,
          (delta) => {
            sendRole();
            text += delta;
            send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] });
          },
          (tc) => { toolCalls.push(tc); },
          (reason, u) => {
            usage = u;
            resolve({ text, toolCalls, usage, finishReason: reason });
          },
          (err) => { reject(err); },
        );
      });

      if (roundResult.toolCalls.length === 0) {
        send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: roundResult.finishReason || 'stop' }] });
        res.write('data: [DONE]\n\n');
        res.end();
        return roundResult;
      }

      const assistantMsg = {
        role: 'assistant',
        content: roundResult.text,
        tool_calls: roundResult.toolCalls.map(tc => ({
          id: tc.id, type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
      messages.push(assistantMsg);

      for (const tc of roundResult.toolCalls) {
        const parsed = safeParse(tc.arguments) || {};
        const output = await executeTool(tc.name, parsed, process.cwd());
        const outputStr = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: outputStr });
      }
    }

    send({ error: { message: 'Tool execution exceeded maximum iterations', type: 'server_error' } });
    res.write('data: [DONE]\n\n');
    res.end();
  }

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.get('/v1/models', async (_req, res) => {
    const models = await fetchModels();
    res.json({ object: 'list', data: models });
  });

  app.post('/v1/chat/completions', async (req, res) => {
    const { model, messages, stream, max_tokens, temperature, tools, tool_choice } = req.body;

    if (!model || !messages) {
      return res.status(400).json({
        error: { message: 'model and messages are required', type: 'invalid_request_error' },
      });
    }

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      try {
        await streamToolLoop(messages, model, tools, tool_choice, max_tokens, temperature, res);
      } catch (err) {
        const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
        send({ error: { message: err.message, type: 'server_error' } });
        send({ id: 'chatcmpl-' + Date.now(), object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        res.write('data: [DONE]\n\n');
        res.end();
      }
    } else {
      try {
        const result = await runToolLoop(messages, model, tools, tool_choice, max_tokens, temperature);

        const message = { role: 'assistant', content: result.content };

        res.json({
          id: 'chatcmpl-' + Date.now(),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message, finish_reason: 'stop' }],
          usage: result.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      } catch (err) {
        res.status(502).json({
          error: { message: err.message, type: 'server_error' },
        });
      }
    }
  });

  return app;
}

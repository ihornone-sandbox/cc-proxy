# cc-proxy

**OpenAI-compatible proxy for Command Code API.**

Use your $1 Command Code plan with any OpenAI-compatible tool — OpenCode, Cline, Claude Code, Continue, or just `curl`.

```
cc-proxy  →  api.commandcode.ai/alpha/generate
(OpenAI format)      (Command Code internal API)
```

## Why?

Command Code gives you a $1 starter plan with **$10 worth of credits** for models like DeepSeek V4 Pro, Qwen 3.7 Max, and many more — but only through the `cmd` CLI. The official Provider API requires a $19+ Pro plan.

This proxy bridges the gap. It uses the **same internal API** as the `cmd` CLI, translates OpenAI-format requests on the fly, and exposes them through a standard `/v1/chat/completions` endpoint. No Pro plan needed.

## Quick Start

### 1. Install

```bash
git clone https://github.com/ihornone-sandbox/cc-proxy
cd cc-proxy
npm install
```

Requires Node.js 18+.

### 2. Authenticate

```bash
cmd login
```

The proxy picks up your key from `~/.commandcode/auth.json`.

### 3. Start

```bash
node index.js
```

```
cc-proxy v1.2.0
Starting proxy on http://127.0.0.1:55990
Models: GET  http://127.0.0.1:55990/v1/models
Chat:   POST http://127.0.0.1:55990/v1/chat/completions
Proxy is ready. Press Ctrl+C to stop.
```

### 4. Use it

#### OpenCode

In your `opencode.json`:

```json
{
  "provider": {
    "cmdcode": {
      "name": "Command Code (proxy)",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:55990/v1",
        "apiKey": "proxy"
      },
      "models": {
        "deepseek/deepseek-v4-flash": {
          "name": "DeepSeek V4 Flash",
          "limit": { "context": 1000000, "output": 65536 }
        },
        "deepseek/deepseek-v4-pro": {
          "name": "DeepSeek V4 Pro",
          "limit": { "context": 1000000, "output": 65536 }
        },
        "MiniMaxAI/MiniMax-M3": {
          "name": "MiniMax M3",
          "limit": { "context": 1000000, "output": 65536 }
        }
      }
    }
  },
  "model": "cmdcode/deepseek/deepseek-v4-flash"
}
```

#### Cline / Roo Code / Continue

```json
{
  "apiProvider": "openai",
  "openAiBaseUrl": "http://127.0.0.1:55990/v1",
  "openAiApiKey": "dummy",
  "openAiModel": "deepseek/deepseek-v4-flash"
}
```

#### curl

```bash
curl -s http://127.0.0.1:55990/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Write a haiku"}],
    "stream": true
  }'
```

## Configuration

| Flag | Default | Description |
|---|---|---|
| `--port, -p` | `55990` | Server port |
| `--host, -h` | `127.0.0.1` | Bind address |
| `--api-key, -k` | — | API key |
| `--version, -v` | — | Show version |
| `--help` | — | Show help |

**Env vars:** `PORT`, `HOST`, `COMMANDCODE_API_KEY`, `MAX_BODY_SIZE` (default `50mb`).

## Requirements

- Node.js 18+
- Command Code CLI (`npm install -g command-code`) + `cmd login`
- Active Command Code plan ($1 starter works)

## License

MIT

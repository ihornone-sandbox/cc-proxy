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
# Option A — git clone (requires Node.js 18+)
git clone https://github.com/ihornone-sandbox/cc-proxy
cd cc-proxy
npm install

# Option B — one-liner (Linux/macOS)
curl -fsSL https://raw.githubusercontent.com/ihornone-sandbox/cc-proxy/main/install.sh | bash
```

### 2. Authenticate

```bash
# Make sure you're logged into Command Code
cmd login
```

The proxy automatically picks up your API key from `~/.commandcode/auth.json`.

### 3. Start the proxy

```bash
# if you cloned the repo
node index.js

# if you used the install script
cc-proxy
```

```
cc-proxy v1.0.0
Starting proxy on http://127.0.0.1:55990
Models: GET  http://127.0.0.1:55990/v1/models
Chat:   POST http://127.0.0.1:55990/v1/chat/completions
Proxy is ready. Press Ctrl+C to stop.
```

### 4. Use it

#### OpenCode

Add to `~/.config/opencode/opencode.jsonc` or your project's `opencode.json`:

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

#### Claude Code

```bash
export CLAUDE_CODE_BASE_URL=http://127.0.0.1:55990/v1
claude
```

#### curl

```bash
curl -s http://127.0.0.1:55990/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Write a haiku about coding"}],
    "stream": true
  }'
```

## Features

- **OpenAI-compatible** — drop-in replacement for any OpenAI client
- **Streaming** — full SSE support (`stream: true`)
- **Non-streaming** — regular JSON responses (`stream: false`)
- **Tools / Function calling** — convert between OpenAI and Command Code formats
- **System messages** — extracted and forwarded correctly
- **Multi-turn conversations** — full history support
- **Open-weight models** — DeepSeek, Qwen, MiniMax, MiMo, Kimi, GLM, Step, Nemotron
- **Model list** — `GET /v1/models` returns all available models
- **Auto-auth** — reads key from `~/.commandcode/auth.json`, env var, or CLI flag
- **Cross-platform** — Linux, macOS, Windows

## Available Models

```bash
curl http://127.0.0.1:55990/v1/models | jq '.data[].id'
```

| Model ID | Description |
|---|---|
| `deepseek/deepseek-v4-pro` | DeepSeek V4 Pro (1M context) |
| `deepseek/deepseek-v4-flash` | DeepSeek V4 Flash (1M context) |
| `Qwen/Qwen3.7-Max` | Qwen 3.7 Max (1M context) |
| `MiniMaxAI/MiniMax-M3` | MiniMax M3 (1M context) |
| `xiaomi/mimo-v2.5-pro` | MiMo V2.5 Pro (1M context) |
| `moonshotai/Kimi-K2.6` | Kimi K2.6 (256K context) |
| `zai-org/GLM-5.1` | GLM-5.1 (200K context) |
| `stepfun/Step-3.7-Flash` | Step 3.7 Flash (256K context) |

## Configuration

### CLI flags

| Flag | Default | Description |
|---|---|---|
| `--port, -p` | `55990` | Server port (env: `PORT`) |
| `--host, -h` | `127.0.0.1` | Bind address (env: `HOST`) |
| `--api-key, -k` | — | API key (env: `COMMANDCODE_API_KEY`) |
| `--version, -v` | — | Show version |
| `--help` | — | Show help |

### API key priority

1. `--api-key` CLI flag
2. `COMMANDCODE_API_KEY` environment variable
3. `~/.commandcode/auth.json` (created by `cmd login`)
4. `~/.config/commandcode/auth.json`

## How credits are used

The proxy uses the **same credits** as the `cmd` CLI. Each request consumes from your Command Code plan balance. You can check your usage with:

```bash
cmd status
```

## Requirements

- **Node.js 18+** — for native `fetch` and ES modules
- **Command Code CLI** — `npm install -g command-code` + `cmd login`
- **Active Command Code plan** — the $1 starter plan works

## FAQ

**Q: Is this against Command Code's terms?**
A: You're using your own paid subscription through the same API as the official CLI. This is a local proxy that translates API formats — it doesn't bypass authentication or steal service.

**Q: Will this work with the free plan?**
A: No. The internal API requires an authenticated session with credits.

**Q: How do I get an API key?**
A: Run `cmd login` in your terminal. The key is stored in `~/.commandcode/auth.json` automatically.

**Q: Can I expose it to my LAN?**
A: Yes: `node index.js --host 0.0.0.0` (or `cc-proxy --host 0.0.0.0` if installed via script). Be careful — anyone on your network can use your credits.

**Q: Why not just use the official Provider API?**
A: The official Provider API requires a Pro plan ($19+/month). This proxy works with the $1 starter plan.

## License

MIT © [Ihor Pelykh](https://github.com/IhorFlowZenith)

# copilot-proxy

An OpenAI-compatible REST API that proxies requests through your GitHub Copilot subscription. Built with Bun, zero runtime dependencies.

Any OpenAI-compatible client (Cursor, Continue, aider, open-webui, custom scripts) can point at this proxy and use Copilot-provided models at no additional cost.

## Requirements

- [Bun](https://bun.sh) >= 1.1
- An active [GitHub Copilot](https://github.com/features/copilot) subscription (Individual, Business, or Enterprise)

## Quick Start

```bash
# Install dev dependencies
bun install

# Authenticate with GitHub Copilot (one-time)
bun run login

# Start the proxy
bun run start
```

On first run of `login`, you'll see:

```
========================================================
  GitHub Copilot — Device Authorization
========================================================

  1. Open:  https://github.com/login/device
  2. Enter: ABCD-1234

  Code expires in 15 minutes.
========================================================

Waiting for authorization...
Authenticated successfully!
```

Once authenticated, start the server:

```
[info] Validating authentication token...
[info] Token is valid.
[info] Copilot Proxy listening on http://0.0.0.0:3000
```

## Usage

### Chat Completions

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### List Models

```bash
curl http://localhost:3000/v1/models
```

### Health Check

```bash
curl http://localhost:3000/health
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat completions |
| `GET` | `/v1/models` | List available models |
| `GET` | `/health` | Health check |

## Available Models

All models are included in your Copilot subscription at no extra cost.

| Model | Family |
|-------|--------|
| `gpt-4o` | OpenAI |
| `gpt-4o-mini` | OpenAI |
| `gpt-4.1` | OpenAI |
| `gpt-4.1-mini` | OpenAI |
| `gpt-4.1-nano` | OpenAI |
| `gpt-5` | OpenAI |
| `gpt-5-mini` | OpenAI |
| `o1` | OpenAI |
| `o1-mini` | OpenAI |
| `o3` | OpenAI |
| `o3-mini` | OpenAI |
| `o4-mini` | OpenAI |
| `claude-3.5-sonnet` | Anthropic |
| `claude-3.7-sonnet` | Anthropic |
| `claude-4-sonnet` | Anthropic |
| `claude-sonnet-4` | Anthropic |
| `gemini-2.0-flash` | Google |
| `gemini-2.5-pro` | Google |

The proxy also accepts model IDs not in this list. If the model follows a known naming pattern (`gpt-*`, `claude-*`, `gemini-*`), the correct family-specific headers and reasoning configuration are applied automatically. Unknown model IDs are forwarded with base Copilot headers — the API itself decides whether to accept them.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `AUTH_FILE` | `~/.config/copilot-proxy/auth.json` | Token storage path |
| `GITHUB_ENTERPRISE_URL` | — | GitHub Enterprise Server URL |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `USER_AGENT` | `copilot-proxy/1.0.0` | User-Agent sent to Copilot API |

## GitHub Enterprise

Set the `GITHUB_ENTERPRISE_URL` variable to use with GitHub Enterprise Server:

```bash
GITHUB_ENTERPRISE_URL=https://github.example.com bun run login
GITHUB_ENTERPRISE_URL=https://github.example.com bun run start
```

The proxy resolves all OAuth and API endpoints relative to your enterprise domain automatically.

## How It Works

1. **Authentication** — Uses GitHub's OAuth Device Flow (RFC 8628) with the public Copilot client ID. The token is stored locally at `~/.config/copilot-proxy/auth.json` with `0600` permissions. Tokens do not expire (valid until revoked).

2. **Startup validation** — On every start, the proxy makes a lightweight request to the Copilot API to verify the token still works. If it fails, the server refuses to start with a clear error message.

3. **Request proxying** — Incoming OpenAI-format requests are transformed (reasoning config injected, `max_tokens` removed, Copilot-specific headers added) and forwarded to `https://api.githubcopilot.com`.

4. **Model routing** — GPT-5+ models (except `gpt-5-mini`) use the Copilot Responses API. All others use Chat Completions. The conversion is transparent — clients always send and receive the standard chat completions format.

5. **Streaming** — SSE streams are passed through directly for chat completions models. For Responses API models, the stream is converted to chat completions SSE format on the fly.

6. **Error handling** — Auth errors (401/403) produce clear re-authentication instructions. Rate limits (429) are forwarded with `Retry-After`. Server errors (5xx) are retried once with exponential backoff. Context overflow is detected and reported.

## Project Structure

```
src/
├── index.ts              # Entry point, CLI commands, startup validation
├── server.ts             # Bun.serve, routing, CORS, request logging
├── config.ts             # Constants, env vars, enterprise URL resolution
├── auth/
│   ├── device-flow.ts    # OAuth Device Flow (RFC 8628)
│   └── storage.ts        # Token persistence (auth.json)
├── proxy/
│   ├── handler.ts        # Main request handler with retry logic
│   ├── headers.ts        # Copilot header construction and stripping
│   ├── routing.ts        # Chat Completions vs Responses API routing
│   ├── transform.ts      # Request body transformations
│   └── stream.ts         # SSE passthrough and format conversion
└── models/
    └── registry.ts       # Model list and family detection
```

## Connecting Clients

Point any OpenAI-compatible client at `http://localhost:3000/v1`:

**Environment variable (works with most clients):**
```bash
export OPENAI_API_BASE=http://localhost:3000/v1
export OPENAI_API_KEY=unused  # required by some clients but not checked
```

**Python (openai SDK):**
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="unused",
)

response = client.chat.completions.create(
    model="claude-sonnet-4",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

**curl (streaming):**
```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-pro",
    "messages": [{"role": "user", "content": "Explain quicksort in 3 sentences"}],
    "stream": true
  }'
```

## License

MIT

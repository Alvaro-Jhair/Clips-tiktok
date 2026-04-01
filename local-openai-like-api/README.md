# local-openai-like-api

Use GPT-4o, GPT-5, Claude Sonnet, Gemini Pro, and 14 other models through a standard OpenAI-compatible API — powered entirely by your existing GitHub Copilot subscription at zero additional cost.

This monorepo contains two components:

- **[`bun-openai-api-like/`](bun-openai-api-like/)** — A local proxy server that authenticates with GitHub Copilot via OAuth and exposes an OpenAI-compatible REST API
- **[`cli-chat/`](cli-chat/)** — An interactive terminal chat client that connects to the proxy

Any tool that speaks the OpenAI API (Cursor, Continue, aider, open-webui, LangChain, custom scripts) can point at this proxy and use Copilot-provided models with no changes.

## Requirements

- [Bun](https://bun.sh) >= 1.1
- An active [GitHub Copilot](https://github.com/features/copilot) subscription (Individual, Business, or Enterprise)

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/your-org/local-openai-like-api.git
cd local-openai-like-api

# 2. Install dependencies
cd bun-openai-api-like && bun install && cd ..

# 3. Authenticate with GitHub Copilot (one-time)
cd bun-openai-api-like && bun run login && cd ..

# 4. Start the proxy server
cd bun-openai-api-like && bun run start
```

The login command initiates GitHub's OAuth Device Flow:

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

Once running, the server is available at `http://localhost:3000`:

```
[info] Validating authentication token...
[info] Token is valid.
[info] Copilot Proxy listening on http://0.0.0.0:3000
```

## Available Models

All models are included in your Copilot subscription at no extra cost.

| Model | Family | Notes |
|-------|--------|-------|
| `gpt-4o` | OpenAI | |
| `gpt-4o-mini` | OpenAI | |
| `gpt-4.1` | OpenAI | |
| `gpt-4.1-mini` | OpenAI | |
| `gpt-4.1-nano` | OpenAI | |
| `gpt-5` | OpenAI | Uses Responses API internally |
| `gpt-5-mini` | OpenAI | |
| `o1` | OpenAI | Reasoning model |
| `o1-mini` | OpenAI | Reasoning model |
| `o3` | OpenAI | Reasoning model |
| `o3-mini` | OpenAI | Reasoning model |
| `o4-mini` | OpenAI | Reasoning model |
| `claude-3.5-sonnet` | Anthropic | |
| `claude-3.7-sonnet` | Anthropic | |
| `claude-4-sonnet` | Anthropic | |
| `claude-sonnet-4` | Anthropic | |
| `gemini-2.0-flash` | Google | |
| `gemini-2.5-pro` | Google | |

The proxy also accepts model IDs not in this list. If the model follows a known naming pattern (`gpt-*`, `claude-*`, `gemini-*`), the correct family-specific headers and reasoning configuration are applied automatically. Unknown model IDs are forwarded with base Copilot headers.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat completions (streaming and non-streaming) |
| `GET` | `/v1/models` | List available models |
| `GET` | `/health` | Health check |

## Usage Examples

### curl

```bash
# Non-streaming
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Streaming
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Explain quicksort in 3 sentences"}],
    "stream": true
  }'

# List models
curl http://localhost:3000/v1/models
```

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="unused",  # required by the SDK but not checked by the proxy
)

response = client.chat.completions.create(
    model="claude-sonnet-4",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

### Node.js / TypeScript (OpenAI SDK)

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:3000/v1",
  apiKey: "unused",
});

const completion = await client.chat.completions.create({
  model: "gemini-2.5-pro",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(completion.choices[0].message.content);
```

### Environment Variables (generic clients)

Most OpenAI-compatible tools respect these variables:

```bash
export OPENAI_API_BASE=http://localhost:3000/v1
export OPENAI_API_KEY=unused  # required by some clients but not checked
```

## CLI Chat Client

The repo includes an interactive terminal chat client for quick testing:

```bash
cd cli-chat
bun install
bun start                          # default model: gpt-4o
bun start --model claude-sonnet-4  # specify a model
bun start -m gemini-2.5-pro        # short flag
```

### Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/clear` | Clear conversation history |
| `/model` | Show current model |
| `/model <name>` | Switch to a different model |
| `/models` | List available models from the API |
| `/system <prompt>` | Set a system prompt |
| `/history` | Show conversation message count |
| `/exit` / `/quit` | Exit the chat |

### CLI Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `API_URL` | `http://localhost:3000` | Base URL of the proxy API |
| `MODEL` | `gpt-4o` | Default model to use |

## How It Works

```
  Any OpenAI-compatible Client
          |
          |  POST /v1/chat/completions (standard format)
          v
  copilot-proxy (localhost:3000)
          |
          |  1. Parse and validate request
          |  2. Transform body (inject reasoning config, remove max_tokens)
          |  3. Route to correct Copilot API format
          |  4. Build Copilot-specific headers
          |  5. Forward with retry on 5xx
          |  6. Convert response format if needed
          v
  GitHub Copilot API (api.githubcopilot.com)
          |
          v
  GPT / Claude / Gemini (actual model provider)
```

### Key Design Details

- **Authentication** uses GitHub's OAuth Device Flow ([RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628)) with the public Copilot client ID. Tokens are stored locally at `~/.config/copilot-proxy/auth.json` with `0600` permissions and remain valid until revoked.

- **Startup validation** sends a lightweight request to the Copilot API on every start to verify the token is still valid. If authentication fails, the server refuses to start with a clear error message.

- **Model-specific reasoning** is automatically configured per family:
  - **Claude**: `thinking.budget_tokens: 4000` with `anthropic-beta` header
  - **OpenAI**: `reasoning: { effort: "medium", summary: "auto" }` with encrypted reasoning content
  - **Gemini**: no reasoning config injected

- **API format routing** is transparent. GPT-5+ models (except `gpt-5-mini`) use the Copilot Responses API (`/responses`); all others use Chat Completions (`/chat/completions`). Clients always send and receive the standard chat completions format regardless.

- **SSE streaming** is passed through directly for Chat Completions models. For Responses API models, stream events are converted to Chat Completions SSE format on the fly.

- **Vision support** is automatic. Image content parts (`image_url`, `input_image`, `image`) are detected and the appropriate `Copilot-Vision-Request` header is set.

- **Multi-turn reasoning state** is preserved. Encrypted `reasoning_opaque` blobs are carried across conversation turns.

- **Error handling** includes auth error detection (401/403) with re-authentication instructions, rate limit forwarding (429 with `Retry-After`), context overflow detection, and single-retry with exponential backoff on 5xx errors.

- **CORS** headers are included on all responses, enabling browser-based clients.

## Proxy Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `AUTH_FILE` | `~/.config/copilot-proxy/auth.json` | Token storage path |
| `GITHUB_ENTERPRISE_URL` | — | GitHub Enterprise Server URL |
| `LOG_LEVEL` | `info` | Logging verbosity: `debug`, `info`, `warn`, `error` |
| `USER_AGENT` | `copilot-proxy/1.0.0` | User-Agent sent to Copilot API |

## GitHub Enterprise

Set the `GITHUB_ENTERPRISE_URL` variable to use with GitHub Enterprise Server:

```bash
GITHUB_ENTERPRISE_URL=https://github.example.com bun run login
GITHUB_ENTERPRISE_URL=https://github.example.com bun run start
```

All OAuth and API endpoints are resolved relative to your enterprise domain automatically.

## Project Structure

```
local-openai-like-api/
├── bun-openai-api-like/              # Proxy server
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts                  # Entry point, CLI commands, startup validation
│       ├── server.ts                 # Bun.serve, routing, CORS, request logging
│       ├── config.ts                 # Constants, env vars, enterprise URL resolution
│       ├── auth/
│       │   ├── device-flow.ts        # OAuth Device Flow (RFC 8628)
│       │   └── storage.ts            # Token persistence (auth.json)
│       ├── proxy/
│       │   ├── handler.ts            # Main request handler with retry logic
│       │   ├── headers.ts            # Copilot header construction
│       │   ├── routing.ts            # Chat Completions vs Responses API routing
│       │   ├── transform.ts          # Request body transformations
│       │   └── stream.ts             # SSE passthrough and format conversion
│       └── models/
│           └── registry.ts           # Model list and family detection
│
├── cli-chat/                         # Interactive CLI chat client
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts                  # Entry point, REPL loop
│       ├── api.ts                    # API client, SSE streaming
│       ├── config.ts                 # Constants, ANSI color helpers
│       ├── commands.ts               # Slash command handler
│       └── history.ts               # Conversation history management
│
└── github_copilot_integration.md     # Implementation specification
```

## Tech Stack

- **Runtime**: [Bun](https://bun.sh) (HTTP server, file I/O, TypeScript execution)
- **Language**: TypeScript (ESNext target, bundler module resolution)
- **Dependencies**: Zero runtime dependencies — everything uses Bun built-ins
- **Dev dependencies**: `bun-types` / `@types/bun` (type definitions only)

## License

MIT

# GitHub Copilot Proxy Service — Implementation Specification

A standalone Bun service that authenticates with a GitHub Copilot subscription and exposes an OpenAI-compatible API, proxying all LLM requests through the Copilot API.

---

## Table of Contents

1. [Overview](#overview)
2. [Authentication](#authentication)
3. [Token Storage](#token-storage)
4. [API Architecture](#api-architecture)
5. [Request Construction](#request-construction)
6. [Response Handling](#response-handling)
7. [Model Registry](#model-registry)
8. [Enterprise Support](#enterprise-support)
9. [Error Handling](#error-handling)
10. [Implementation Plan](#implementation-plan)

---

## 1. Overview

The service acts as a transparent proxy between any OpenAI-compatible client and the GitHub Copilot API. It:

- Authenticates the user via GitHub's OAuth Device Flow (RFC 8628)
- Stores and reuses the OAuth token locally
- Accepts standard OpenAI-format `/v1/chat/completions` requests on a local HTTP server
- Routes requests to the correct Copilot API endpoint (`/chat/completions` or `/responses`)
- Injects all required Copilot-specific headers
- Handles streaming (SSE) and non-streaming responses
- Preserves `reasoning_opaque` blobs for multi-turn reasoning state
- Supports GitHub Enterprise Server deployments

### Runtime

- **Bun** (primary target, >=1.1)
- No external dependencies required beyond Bun built-ins (fetch, serve, file I/O)

---

## 2. Authentication

### OAuth Device Flow (RFC 8628)

The service uses the GitHub OAuth Device Flow. There is **no client secret** — the client ID is public.

#### Constants

| Constant | Value |
|---|---|
| Client ID | `Ov23li8tweQw6odWQebz` |
| Scope | `read:user` |
| Device Code URL (standard) | `https://github.com/login/device/code` |
| Access Token URL (standard) | `https://github.com/login/oauth/access_token` |
| Grant Type | `urn:ietf:params:oauth:grant-type:device_code` |

#### Flow

1. **Request device code**: `POST` to Device Code URL with `client_id` and `scope`. Response contains:
   - `device_code` — used for polling
   - `user_code` — displayed to the user (e.g., `ABCD-1234`)
   - `verification_uri` — URL user visits (typically `https://github.com/login/device`)
   - `expires_in` — seconds until the device code expires
   - `interval` — minimum polling interval in seconds

2. **Prompt the user**: Print `verification_uri` and `user_code` to the terminal. Optionally open the browser automatically.

3. **Poll for access token**: `POST` to Access Token URL with `client_id`, `device_code`, and `grant_type`. Repeat at `interval` seconds.

   **Polling rules** (critical for compliance):
   - Add a **3000ms safety margin** to the `interval` to avoid clock skew issues
   - On `slow_down` error: add **5 seconds** to the interval per RFC 8628 §3.5, or use the server-provided `interval` if present
   - On `authorization_pending`: continue polling
   - On `expired_token`: abort and restart
   - On success: receive `access_token` (typically starts with `ghu_`)

4. **Store the token**: Save to `auth.json` (see [Token Storage](#token-storage))

#### Important Notes

- The GitHub OAuth `access_token` does **not expire** (it lasts until revoked). There is no refresh token flow.
- Both the `refresh` and `access` fields in storage are set to the same `access_token` value with `expires: 0`.
- All requests to GitHub OAuth endpoints must include `Accept: application/json` header.

---

## 3. Token Storage

### File Location

```
~/.config/copilot-proxy/auth.json
```

(Or a configurable path via environment variable.)

### File Permissions

`0o600` (owner read/write only)

### Schema

```json
{
  "github-copilot": {
    "type": "oauth",
    "refresh": "ghu_xxxxxxxxxxxxxxxxxxxx",
    "access": "ghu_xxxxxxxxxxxxxxxxxxxx",
    "expires": 0
  }
}
```

For enterprise deployments, the key becomes `"github-copilot-enterprise"` and includes an `enterpriseUrl` field:

```json
{
  "github-copilot-enterprise": {
    "type": "oauth",
    "refresh": "ghu_xxxxxxxxxxxxxxxxxxxx",
    "access": "ghu_xxxxxxxxxxxxxxxxxxxx",
    "expires": 0,
    "enterpriseUrl": "https://github.example.com"
  }
}
```

### Behavior

- On startup, check if `auth.json` exists and contains a valid token
- If valid, skip the OAuth flow entirely
- If missing or invalid (e.g., 403 from API), trigger re-authentication
- Never log or echo the token value

---

## 4. API Architecture

### Copilot API Base URLs

| Deployment | Base URL |
|---|---|
| Standard (github.com) | `https://api.githubcopilot.com` |
| Enterprise | `https://copilot-api.<normalized-enterprise-domain>` |

Enterprise domain normalization: strip `https://` prefix and trailing `/`.

### Two API Formats

The Copilot API supports two distinct request formats:

| Format | Endpoint | Used For |
|---|---|---|
| Chat Completions | `POST /chat/completions` | Claude, GPT-4o, GPT-5-mini, Gemini, all non-GPT-5+ models |
| Responses API | `POST /responses` | GPT-5 and above (except gpt-5-mini) |

### Routing Logic

```typescript
function shouldUseCopilotResponsesApi(modelId: string): boolean {
  const match = modelId.match(/^gpt-(\d+)/);
  if (!match) return false;
  const version = parseInt(match[1], 10);
  if (version < 5) return false;
  if (modelId.startsWith("gpt-5-mini")) return false;
  return true;
}
```

### Local Server Endpoints

The proxy exposes:

| Endpoint | Method | Description |
|---|---|---|
| `POST /v1/chat/completions` | POST | Standard OpenAI-compatible chat completions |
| `GET /v1/models` | GET | List available models |
| `GET /health` | GET | Health check |
| `POST /auth/login` | POST | Trigger OAuth device flow |
| `GET /auth/status` | GET | Check authentication status |

---

## 5. Request Construction

### Required Headers (every request to Copilot API)

These headers **must** be present on every request:

```
Authorization: Bearer <github_oauth_token>
User-Agent: copilot-proxy/1.0.0
Openai-Intent: conversation-edits
Content-Type: application/json
```

### Dynamic Headers

| Header | Value | Condition |
|---|---|---|
| `x-initiator` | `"user"` or `"agent"` | Based on the `role` of the last message in the request. If `role === "user"` → `"user"`, otherwise → `"agent"` |
| `Copilot-Vision-Request` | `"true"` | Set when the request body contains image content (detected by checking for `image_url` type in message content parts) |
| `anthropic-beta` | `"interleaved-thinking-2025-05-14"` | Set only for Claude models (model ID contains `"claude"`) |

### Headers to Strip from Incoming Requests

Before forwarding, **remove** these headers from the incoming client request (case-insensitive):

- `x-api-key`
- `authorization`

The proxy's own `Authorization: Bearer <token>` header replaces the client's.

### Request Body Modifications

1. **Do NOT send `max_tokens` / `maxOutputTokens`** — Copilot manages this internally. Remove if present.
2. **`store: false`** — Add this for OpenAI-family models (GPT-*) to prevent server-side storage.
3. **`stream_options`** — If the client requests streaming, include `{ "include_usage": true }` so usage stats are returned.

### Reasoning Configuration

Different model families require different reasoning parameters in the request body:

#### Claude Models (model ID contains "claude")

```json
{
  "thinking": {
    "budget_tokens": 4000
  }
}
```

#### OpenAI/GPT Models (model ID starts with "gpt-" or "o1-" etc.)

```json
{
  "reasoning": {
    "effort": "medium",
    "summary": "auto"
  },
  "include": ["reasoning.encrypted_content"]
}
```

Valid `effort` values: `"low"`, `"medium"`, `"high"` — configurable per request.

#### Gemini Models

No thinking/reasoning configuration supported via Copilot (as of this writing).

### Cache Control

For messages that should leverage caching, use the Copilot-specific key:

```json
{
  "copilot_cache_control": { "type": "ephemeral" }
}
```

This is distinct from Anthropic's standard `cache_control` key.

---

## 6. Response Handling

### Non-Streaming Responses

Standard OpenAI-format JSON response. The proxy passes it through with minimal modification.

### Streaming Responses (SSE)

The Copilot API returns Server-Sent Events in the standard OpenAI streaming format:

```
data: {"id":"...","choices":[{"delta":{"content":"Hello"},...}],...}
data: {"id":"...","choices":[{"delta":{"content":" world"},...}],...}
data: [DONE]
```

The proxy streams these through to the client as-is.

### Copilot-Specific Response Extensions

The Copilot API adds two non-standard fields to response choices that **must** be handled:

#### `reasoning_text`

- Contains visible chain-of-thought / thinking text
- In streaming: arrives as deltas **before** `content` deltas
- Should be forwarded to the client (either as-is or mapped to a standard field depending on client expectations)

#### `reasoning_opaque`

- **Critical**: An encrypted binary blob representing the model's internal reasoning state
- Required for multi-turn conversations — must be preserved and sent back in the next request's assistant message
- Emitted **once** as a complete blob (not streamed in deltas)
- Only one `reasoning_opaque` value per response (error if multiple received)
- Must be stored and included in subsequent requests for the same conversation

#### Preserving `reasoning_opaque` for Multi-Turn

When the proxy receives a `reasoning_opaque` blob in a response:

1. Include it in the response to the client (as a custom field or in metadata)
2. When the client sends the next request, the proxy should look for the `reasoning_opaque` value in the assistant message and include it in the forwarded request

The client is responsible for threading the opaque blob back. The proxy should transparently pass it through.

---

## 7. Model Registry

### Available Models (as of writing)

The proxy should expose at minimum these models via `/v1/models`:

| Model ID | Family | API Format | Notes |
|---|---|---|---|
| `gpt-4o` | OpenAI | Chat Completions | |
| `gpt-4o-mini` | OpenAI | Chat Completions | |
| `gpt-4.1` | OpenAI | Chat Completions | |
| `gpt-4.1-mini` | OpenAI | Chat Completions | |
| `gpt-4.1-nano` | OpenAI | Chat Completions | |
| `gpt-5` | OpenAI | Responses | |
| `gpt-5-mini` | OpenAI | Chat Completions | Exception: uses chat despite being GPT-5 |
| `o1` | OpenAI | Chat Completions | |
| `o1-mini` | OpenAI | Chat Completions | |
| `o3` | OpenAI | Chat Completions | |
| `o3-mini` | OpenAI | Chat Completions | |
| `o4-mini` | OpenAI | Chat Completions | |
| `claude-3.5-sonnet` | Anthropic | Chat Completions | |
| `claude-3.7-sonnet` | Anthropic | Chat Completions | Has thinking variant |
| `claude-4-sonnet` | Anthropic | Chat Completions | Has thinking variant |
| `claude-sonnet-4` | Anthropic | Chat Completions | Has thinking variant |
| `gemini-2.0-flash` | Google | Chat Completions | |
| `gemini-2.5-pro` | Google | Chat Completions | |

### Model Detection Helpers

```typescript
function isClaude(modelId: string): boolean {
  return modelId.includes("claude");
}

function isOpenAI(modelId: string): boolean {
  return modelId.startsWith("gpt-") || modelId.startsWith("o1") || modelId.startsWith("o3") || modelId.startsWith("o4");
}

function isGemini(modelId: string): boolean {
  return modelId.startsWith("gemini");
}
```

### Cost

All models through Copilot are **$0 cost** (included in the Copilot subscription). The `/v1/models` response should reflect this.

---

## 8. Enterprise Support

### Configuration

Enterprise support is configured via environment variable:

```
GITHUB_ENTERPRISE_URL=https://github.example.com
```

### URL Resolution

When an enterprise URL is configured:

| Endpoint | Standard | Enterprise |
|---|---|---|
| Device Code | `https://github.com/login/device/code` | `https://github.example.com/login/device/code` |
| Access Token | `https://github.com/login/oauth/access_token` | `https://github.example.com/login/oauth/access_token` |
| Copilot API | `https://api.githubcopilot.com` | `https://copilot-api.github.example.com` |

### Domain Normalization

```typescript
function normalizeEnterpriseUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function getCopilotApiBaseUrl(enterpriseUrl?: string): string {
  if (!enterpriseUrl) return "https://api.githubcopilot.com";
  return `https://copilot-api.${normalizeEnterpriseUrl(enterpriseUrl)}`;
}
```

### Token Storage Key

Enterprise tokens use the key `"github-copilot-enterprise"` instead of `"github-copilot"` in `auth.json`.

---

## 9. Error Handling

### HTTP Status Codes from Copilot API

| Status | Meaning | Action |
|---|---|---|
| `200` | Success | Forward response |
| `400` | Bad request | Forward error to client |
| `401` | Unauthorized | Re-authenticate |
| `403` | Forbidden | Token revoked or insufficient permissions. Log "Please reauthenticate" and trigger re-auth |
| `429` | Rate limited | Forward to client with `Retry-After` header if present |
| `500+` | Server error | Forward error to client |

### Context Overflow Detection

The Copilot API may return context length errors. Detect via regex:

```
/exceeds the limit of \d+/i
```

When detected, return a clear error to the client indicating the context window was exceeded.

### Stream Error Codes

During streaming, error events may include these codes in the `error` field:

| Code | Meaning |
|---|---|
| `context_length_exceeded` | Input too long |
| `insufficient_quota` | Copilot quota exhausted |
| `usage_not_included` | Model not available on user's plan |
| `invalid_prompt` | Content policy violation or invalid input |

These should be forwarded to the client as-is.

### Retry Strategy

- **Do NOT retry** on 4xx errors (client errors are deterministic)
- **Retry once** on 5xx errors with exponential backoff (initial: 1s, max: 5s)
- **Do NOT retry** on stream errors (the stream is already broken)

---

## 10. Implementation Plan

### Project Structure

```
bun-openai-api-like/
├── src/
│   ├── index.ts              # Entry point, starts HTTP server
│   ├── server.ts             # Bun.serve configuration, route handling
│   ├── auth/
│   │   ├── device-flow.ts    # OAuth device flow implementation
│   │   └── storage.ts        # Token read/write from auth.json
│   ├── proxy/
│   │   ├── handler.ts        # Main request handler for /v1/chat/completions
│   │   ├── headers.ts        # Header construction and stripping
│   │   ├── routing.ts        # API format routing (chat vs responses)
│   │   ├── transform.ts      # Request body transformation (reasoning, cache, etc.)
│   │   └── stream.ts         # SSE stream passthrough and transformation
│   ├── models/
│   │   └── registry.ts       # Model list and detection helpers
│   └── config.ts             # Environment variables, constants
├── package.json
├── tsconfig.json
└── bunfig.toml
```

### Implementation Order

1. **Config & Constants** — Client ID, URLs, environment variable handling
2. **Auth Storage** — Read/write `auth.json` with proper permissions
3. **OAuth Device Flow** — Complete implementation with polling, slow_down handling
4. **Model Registry** — Model list, family detection, API format routing
5. **Header Construction** — Required + conditional headers, stripping logic
6. **Request Transformation** — Body modifications, reasoning config injection
7. **Proxy Handler** — Core request forwarding logic
8. **Stream Passthrough** — SSE handling with `reasoning_text`/`reasoning_opaque` support
9. **HTTP Server** — Bun.serve with all routes
10. **Error Handling** — Status codes, overflow detection, stream errors
11. **Enterprise Support** — URL resolution, domain normalization

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | Local server port |
| `HOST` | `0.0.0.0` | Local server bind address |
| `AUTH_FILE` | `~/.config/copilot-proxy/auth.json` | Token storage path |
| `GITHUB_ENTERPRISE_URL` | (none) | Enterprise GitHub URL |
| `LOG_LEVEL` | `info` | Logging verbosity (`debug`, `info`, `warn`, `error`) |
| `USER_AGENT` | `copilot-proxy/1.0.0` | User-Agent string sent to Copilot API |

### Usage Example

```bash
# First run — triggers OAuth device flow
bun run src/index.ts

# Output:
# Please visit https://github.com/login/device
# Enter code: ABCD-1234
# Waiting for authorization...
# Authenticated successfully!
# Copilot Proxy listening on http://0.0.0.0:8080

# Use with any OpenAI-compatible client
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

---

## Appendix A: Reference Source Files

These files from the OpenCode codebase were analyzed to produce this spec:

| File | Purpose |
|---|---|
| `opencode-dev/.../plugin/copilot.ts` | OAuth device flow, custom fetch wrapper, header injection |
| `opencode-dev/.../provider/provider.ts` | Provider registry, model routing, SDK loading |
| `opencode-dev/.../provider/transform.ts` | Reasoning config, cache control, provider options |
| `opencode-dev/.../provider/error.ts` | Error detection patterns, stream error codes |
| `opencode-dev/.../auth/index.ts` | Token storage schema, file I/O |
| `opencode-dev/.../provider/auth.ts` | OAuth authorize/callback flow |
| `opencode-dev/.../session/llm.ts` | maxOutputTokens handling, stream orchestration |
| `opencode-dev/.../provider/sdk/copilot/` | Custom AI SDK for reasoning_text/reasoning_opaque |

## Appendix B: Full Header Reference

### Headers sent TO Copilot API

```
Authorization: Bearer ghu_xxxxxxxxxxxxxxxxxxxx
User-Agent: copilot-proxy/1.0.0
Content-Type: application/json
Openai-Intent: conversation-edits
x-initiator: user|agent
Copilot-Vision-Request: true                          (conditional)
anthropic-beta: interleaved-thinking-2025-05-14       (conditional, Claude only)
```

### Headers REMOVED from client request before forwarding

```
x-api-key       (any case)
authorization   (any case — replaced by proxy's own)
```

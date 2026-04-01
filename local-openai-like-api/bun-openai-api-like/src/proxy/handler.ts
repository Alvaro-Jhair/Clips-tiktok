import {
  GITHUB_ENTERPRISE_URL,
  getAuthStorageKey,
  log,
} from "../config";
import { getAccessToken } from "../auth/storage";
import { buildCopilotHeaders } from "./headers";
import type { ChatRequestBody } from "./headers";
import { transformRequestBody } from "./transform";
import { routeRequest, responsesToChatResponse } from "./routing";
import { passthroughStream, responsesToChatStream } from "./stream";

// ---------------------------------------------------------------------------
// Context overflow detection
// ---------------------------------------------------------------------------
const CONTEXT_OVERFLOW_RE = /exceeds the limit of \d+/i;

// ---------------------------------------------------------------------------
// Main handler for POST /v1/chat/completions
// ---------------------------------------------------------------------------

export async function handleChatCompletions(req: Request): Promise<Response> {
  // 1. Get the auth token
  const storageKey = getAuthStorageKey(GITHUB_ENTERPRISE_URL);
  const token = await getAccessToken(storageKey);

  if (!token) {
    return jsonResponse(
      401,
      {
        error: {
          message: "Not authenticated. Run `bun run src/index.ts login` to authenticate.",
          type: "auth_error",
          code: "not_authenticated",
        },
      },
    );
  }

  // 2. Parse the request body
  let body: ChatRequestBody;
  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    return jsonResponse(400, {
      error: {
        message: "Invalid JSON in request body",
        type: "invalid_request_error",
        code: "invalid_json",
      },
    });
  }

  if (!body.model) {
    return jsonResponse(400, {
      error: {
        message: "Missing required field: model",
        type: "invalid_request_error",
        code: "missing_model",
      },
    });
  }

  // 3. Transform the body
  transformRequestBody(body);

  // 4. Route to the correct endpoint
  const route = routeRequest(body);

  // 5. Build headers
  const headers = buildCopilotHeaders(token, body);

  // 6. Forward the request (with retry on 5xx)
  const response = await forwardWithRetry(
    route.url,
    headers,
    route.body,
  );

  if (!response) {
    return jsonResponse(502, {
      error: {
        message: "Failed to reach Copilot API",
        type: "api_error",
        code: "upstream_error",
      },
    });
  }

  // 7. Handle error responses
  if (!response.ok) {
    return handleErrorResponse(response);
  }

  // 8. Handle streaming vs non-streaming
  const isStreaming = body.stream === true;

  if (isStreaming && response.body) {
    // Streaming response
    const stream = route.needsResponseConversion
      ? responsesToChatStream(response.body, body.model)
      : passthroughStream(response.body);

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // Non-streaming response
  const data = await response.json();

  if (route.needsResponseConversion) {
    const converted = responsesToChatResponse(
      data as Record<string, unknown>,
      body.model,
    );
    return jsonResponse(200, converted);
  }

  return jsonResponse(200, data);
}

// ---------------------------------------------------------------------------
// Forward with single retry on 5xx
// ---------------------------------------------------------------------------

async function forwardWithRetry(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  maxRetries = 1,
): Promise<Response | null> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      // Only retry on 5xx
      if (response.status >= 500 && attempt < maxRetries) {
        log.warn(
          `Upstream ${response.status}, retrying (attempt ${attempt + 1})...`,
        );
        const backoff = Math.min(1000 * Math.pow(2, attempt), 5000);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }

      return response;
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxRetries) {
        log.warn(`Fetch failed, retrying: ${lastError.message}`);
        const backoff = Math.min(1000 * Math.pow(2, attempt), 5000);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
    }
  }

  log.error("All retry attempts failed:", lastError?.message);
  return null;
}

// ---------------------------------------------------------------------------
// Error response handling
// ---------------------------------------------------------------------------

async function handleErrorResponse(response: Response): Promise<Response> {
  const status = response.status;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = { error: { message: await response.text() } };
  }

  // Check for context overflow
  const bodyStr = JSON.stringify(body);
  if (CONTEXT_OVERFLOW_RE.test(bodyStr)) {
    return jsonResponse(400, {
      error: {
        message:
          "Context window exceeded. Reduce the number of messages or their length.",
        type: "invalid_request_error",
        code: "context_length_exceeded",
      },
    });
  }

  // Auth errors
  if (status === 401 || status === 403) {
    log.error(
      "Authentication failed. Please re-authenticate: bun run src/index.ts login",
    );
    return jsonResponse(status, {
      error: {
        message:
          "Authentication failed. Please re-authenticate by running: bun run src/index.ts login",
        type: "auth_error",
        code: status === 401 ? "unauthorized" : "forbidden",
      },
    });
  }

  // Rate limited — forward with Retry-After if present
  if (status === 429) {
    const retryAfter = response.headers.get("Retry-After");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    };
    if (retryAfter) headers["Retry-After"] = retryAfter;

    return new Response(JSON.stringify(body), { status: 429, headers });
  }

  // All other errors — forward as-is
  return jsonResponse(status, body);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

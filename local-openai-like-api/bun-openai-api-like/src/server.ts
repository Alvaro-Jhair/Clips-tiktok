import { PORT, HOST, log } from "./config";
import { handleChatCompletions } from "./proxy/handler";
import { buildModelsResponse } from "./models/registry";

// ---------------------------------------------------------------------------
// HTTP Server using Bun.serve
// ---------------------------------------------------------------------------

export function startServer(): void {
  try {
    Bun.serve({
      port: PORT,
      hostname: HOST,
      fetch: handleRequest,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Failed to start server on ${HOST}:${PORT} — ${msg}`);
    process.exit(1);
  }

  log.info(`Copilot Proxy listening on http://${HOST}:${PORT}`);
  log.info("Endpoints:");
  log.info("  POST /v1/chat/completions  — OpenAI-compatible chat");
  log.info("  GET  /v1/models            — List available models");
  log.info("  GET  /health               — Health check");
}

// ---------------------------------------------------------------------------
// Request router
// ---------------------------------------------------------------------------

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;
  const start = performance.now();

  // CORS preflight
  if (method === "OPTIONS") {
    return corsResponse(204);
  }

  let response: Response;

  try {
    response = await route(method, path, req);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    log.error("Unhandled error:", message);
    response = jsonResponse(500, {
      error: {
        message: "Internal server error",
        type: "api_error",
        code: "internal_error",
      },
    });
  }

  const duration = (performance.now() - start).toFixed(1);
  log.info(`${method} ${path} ${response.status} ${duration}ms`);

  return response;
}

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

async function route(
  method: string,
  path: string,
  req: Request,
): Promise<Response> {
  // POST /v1/chat/completions
  if (method === "POST" && path === "/v1/chat/completions") {
    return handleChatCompletions(req);
  }

  // GET /v1/models
  if (method === "GET" && path === "/v1/models") {
    return jsonResponse(200, buildModelsResponse());
  }

  // GET /health
  if (method === "GET" && path === "/health") {
    return jsonResponse(200, { status: "ok" });
  }

  // 404
  return jsonResponse(404, {
    error: {
      message: `Unknown endpoint: ${method} ${path}`,
      type: "invalid_request_error",
      code: "not_found",
    },
  });
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
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

function corsResponse(status: number): Response {
  return new Response(null, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    },
  });
}

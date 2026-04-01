import { isClaude, isOpenAI } from "../models/registry";
import type { ChatRequestBody } from "./headers";

// ---------------------------------------------------------------------------
// Request body transformations applied before forwarding to Copilot API
// ---------------------------------------------------------------------------

/**
 * Transform an incoming OpenAI-format request body for the Copilot API.
 * Mutates and returns the same object.
 */
export function transformRequestBody(body: ChatRequestBody): ChatRequestBody {
  const model = body.model;

  // 1. Remove max_tokens / maxOutputTokens — Copilot manages internally
  delete body.max_tokens;
  delete (body as Record<string, unknown>).maxOutputTokens;

  // 2. store: false for OpenAI family models
  if (isOpenAI(model)) {
    body.store = false;
  }

  // 3. stream_options: include usage stats when streaming
  if (body.stream) {
    body.stream_options = { include_usage: true };
  }

  // 4. Inject reasoning configuration per model family
  injectReasoningConfig(body, model);

  return body;
}

// ---------------------------------------------------------------------------
// Reasoning config injection
// ---------------------------------------------------------------------------

function injectReasoningConfig(body: ChatRequestBody, model: string): void {
  if (isClaude(model)) {
    // Claude thinking configuration
    if (!body.thinking) {
      body.thinking = { budget_tokens: 4000 };
    }
    return;
  }

  if (isOpenAI(model)) {
    // OpenAI reasoning configuration
    if (!body.reasoning) {
      body.reasoning = { effort: "medium", summary: "auto" };
    }
    if (!body.include) {
      body.include = ["reasoning.encrypted_content"];
    }
    return;
  }

  // Gemini and unknown families: no reasoning config
}

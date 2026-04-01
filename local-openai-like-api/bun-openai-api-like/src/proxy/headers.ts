import { USER_AGENT } from "../config";
import { isClaude } from "../models/registry";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface MessagePart {
  type?: string;
  [key: string]: unknown;
}

export interface Message {
  role?: string;
  content?: string | MessagePart[];
  [key: string]: unknown;
}

export interface ChatRequestBody {
  model: string;
  messages?: Message[];
  stream?: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Header construction
// ---------------------------------------------------------------------------

/**
 * Build the headers to send to the Copilot API.
 */
export function buildCopilotHeaders(
  token: string,
  body: ChatRequestBody,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "User-Agent": USER_AGENT,
    "Content-Type": "application/json",
    "Openai-Intent": "conversation-edits",
  };

  // x-initiator: based on role of last message
  const lastMsg = body.messages?.at(-1);
  headers["x-initiator"] =
    lastMsg?.role === "user" ? "user" : "agent";

  // Copilot-Vision-Request: if any message contains image content
  if (hasImageContent(body)) {
    headers["Copilot-Vision-Request"] = "true";
  }

  // anthropic-beta: for Claude models
  if (isClaude(body.model)) {
    headers["anthropic-beta"] = "interleaved-thinking-2025-05-14";
  }

  return headers;
}

// ---------------------------------------------------------------------------
// Header stripping (remove client-supplied auth headers)
// ---------------------------------------------------------------------------

const STRIP_HEADERS = new Set(["x-api-key", "authorization"]);

/**
 * Remove headers that must not be forwarded from the incoming client request.
 * Returns a new Headers object.
 */
export function stripClientHeaders(incoming: Headers): Headers {
  const cleaned = new Headers();
  incoming.forEach((value, key) => {
    if (!STRIP_HEADERS.has(key.toLowerCase())) {
      cleaned.set(key, value);
    }
  });
  return cleaned;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasImageContent(body: ChatRequestBody): boolean {
  if (!body.messages) return false;
  for (const msg of body.messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (
          part.type === "image_url" ||
          part.type === "input_image" ||
          part.type === "image"
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

import { getCopilotApiBaseUrl, GITHUB_ENTERPRISE_URL } from "../config";
import { shouldUseCopilotResponsesApi } from "../models/registry";
import type { ChatRequestBody, Message } from "./headers";

// ---------------------------------------------------------------------------
// Routing: determine Copilot API endpoint and transform format if needed
// ---------------------------------------------------------------------------

export interface RouteResult {
  /** Full URL to send the request to */
  url: string;
  /** The body to send (may be transformed for Responses API) */
  body: ChatRequestBody | ResponsesRequestBody;
  /** Whether the response needs to be converted back to chat format */
  needsResponseConversion: boolean;
}

// ---------------------------------------------------------------------------
// Responses API types (subset)
// ---------------------------------------------------------------------------

interface ResponsesInputItem {
  type: string;
  role?: string;
  content?: string | object[];
  [key: string]: unknown;
}

interface ResponsesRequestBody {
  model: string;
  input: ResponsesInputItem[];
  stream?: boolean;
  store?: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function routeRequest(body: ChatRequestBody): RouteResult {
  const baseUrl = getCopilotApiBaseUrl(GITHUB_ENTERPRISE_URL);
  const useResponses = shouldUseCopilotResponsesApi(body.model);

  if (!useResponses) {
    return {
      url: `${baseUrl}/chat/completions`,
      body,
      needsResponseConversion: false,
    };
  }

  // Convert chat completions format → responses format
  return {
    url: `${baseUrl}/responses`,
    body: chatToResponsesBody(body),
    needsResponseConversion: true,
  };
}

// ---------------------------------------------------------------------------
// Format conversion: Chat Completions → Responses API
// ---------------------------------------------------------------------------

function chatToResponsesBody(chat: ChatRequestBody): ResponsesRequestBody {
  const input: ResponsesInputItem[] = [];

  if (chat.messages) {
    for (const msg of chat.messages) {
      input.push(convertMessage(msg));
    }
  }

  const result: ResponsesRequestBody = {
    model: chat.model,
    input,
    stream: chat.stream ?? false,
  };

  if (chat.store !== undefined) result.store = chat.store as boolean;
  if (chat.reasoning) (result as Record<string, unknown>).reasoning = chat.reasoning;
  if (chat.include) (result as Record<string, unknown>).include = chat.include;

  // Forward stream options
  if (chat.stream) {
    (result as Record<string, unknown>).stream = true;
  }

  return result;
}

function convertMessage(msg: Message): ResponsesInputItem {
  const role = msg.role ?? "user";

  // Map "assistant" → "assistant", "user" → "user", "system" → "system"
  const item: ResponsesInputItem = {
    type: "message",
    role,
  };

  if (typeof msg.content === "string") {
    item.content = msg.content;
  } else if (Array.isArray(msg.content)) {
    item.content = msg.content;
  }

  // Preserve reasoning_opaque if present (multi-turn reasoning)
  if (msg.reasoning_opaque) {
    item.reasoning_opaque = msg.reasoning_opaque;
  }

  return item;
}

// ---------------------------------------------------------------------------
// Format conversion: Responses API → Chat Completions (non-streaming)
// ---------------------------------------------------------------------------

export function responsesToChatResponse(
  responsesData: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const output = (responsesData.output ?? []) as Record<string, unknown>[];

  // Collect text content from output items
  let textContent = "";
  let reasoningOpaque: string | undefined;
  let reasoningText: string | undefined;

  for (const item of output) {
    if (item.type === "message") {
      const content = item.content as Record<string, unknown>[] | undefined;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === "output_text") {
            textContent += (part.text as string) ?? "";
          }
        }
      }
    }
    if (item.type === "reasoning") {
      if (item.encrypted_content) {
        reasoningOpaque = item.encrypted_content as string;
      }
      const summary = item.summary as Record<string, unknown>[] | undefined;
      if (Array.isArray(summary)) {
        for (const s of summary) {
          if (s.type === "summary_text") {
            reasoningText = (reasoningText ?? "") + ((s.text as string) ?? "");
          }
        }
      }
    }
  }

  const usage = responsesData.usage as Record<string, unknown> | undefined;

  const chatResponse: Record<string, unknown> = {
    id: responsesData.id ?? `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: textContent,
          ...(reasoningOpaque ? { reasoning_opaque: reasoningOpaque } : {}),
          ...(reasoningText ? { reasoning_text: reasoningText } : {}),
        },
        finish_reason: (responsesData.status as string) === "completed" ? "stop" : "stop",
      },
    ],
    ...(usage
      ? {
          usage: {
            prompt_tokens: usage.input_tokens ?? 0,
            completion_tokens: usage.output_tokens ?? 0,
            total_tokens:
              ((usage.input_tokens as number) ?? 0) +
              ((usage.output_tokens as number) ?? 0),
          },
        }
      : {}),
  };

  return chatResponse;
}

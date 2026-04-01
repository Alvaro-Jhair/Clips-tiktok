// ---------------------------------------------------------------------------
// SSE stream passthrough and Responses → Chat format conversion
// ---------------------------------------------------------------------------

/**
 * Create a ReadableStream that passes through SSE from the Copilot API
 * directly to the client. Used for /chat/completions responses (no
 * conversion needed).
 */
export function passthroughStream(upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  // Straight passthrough — the upstream is already in the correct SSE format
  return upstream;
}

/**
 * Convert a Responses API SSE stream into a Chat Completions SSE stream.
 *
 * The Responses API emits events like:
 *   event: response.output_text.delta
 *   data: {"type":"response.output_text.delta","item_id":"...","output_index":0,"content_index":0,"delta":"Hello"}
 *
 * We convert them to OpenAI chat completions streaming format:
 *   data: {"id":"...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"}}]}
 */
export function responsesToChatStream(
  upstream: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const responseId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  let buffer = "";
  let reasoningOpaque: string | undefined;
  let sentFirstChunk = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            // Send [DONE]
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            return;
          }

          buffer += decoder.decode(value, { stream: true });

          // Process complete SSE lines
          const lines = buffer.split("\n");
          // Keep the last incomplete line in the buffer
          buffer = lines.pop() ?? "";

          let currentEvent = "";

          for (const line of lines) {
            if (line.startsWith("event: ")) {
              currentEvent = line.slice(7).trim();
              continue;
            }

            if (!line.startsWith("data: ")) continue;

            const dataStr = line.slice(6);
            if (dataStr === "[DONE]") {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
              return;
            }

            let data: Record<string, unknown>;
            try {
              data = JSON.parse(dataStr);
            } catch {
              continue;
            }

            const eventType = currentEvent || (data.type as string) || "";

            // Map Responses API events to chat completions chunks
            const chunk = mapResponseEventToChatChunk(
              eventType,
              data,
              responseId,
              created,
              model,
              sentFirstChunk,
            );

            // Track reasoning_opaque
            if (data.encrypted_content) {
              reasoningOpaque = data.encrypted_content as string;
            }

            if (chunk) {
              // Attach reasoning_opaque to the last chunk if we have it
              if (
                eventType === "response.completed" ||
                eventType === "response.done"
              ) {
                if (reasoningOpaque && chunk.choices?.[0]) {
                  (chunk.choices[0] as Record<string, unknown>).reasoning_opaque =
                    reasoningOpaque;
                }
              }

              const sseMsg = `data: ${JSON.stringify(chunk)}\n\n`;
              controller.enqueue(encoder.encode(sseMsg));
              sentFirstChunk = true;
            }
          }
        }
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Map a single Responses API event → Chat Completions chunk
// ---------------------------------------------------------------------------

interface ChatChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Record<string, unknown>[];
  usage?: Record<string, unknown>;
}

function mapResponseEventToChatChunk(
  eventType: string,
  data: Record<string, unknown>,
  id: string,
  created: number,
  model: string,
  _sentFirst: boolean,
): ChatChunk | null {
  switch (eventType) {
    case "response.output_text.delta": {
      return {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: { content: data.delta as string },
            finish_reason: null,
          },
        ],
      };
    }

    case "response.reasoning_summary_text.delta": {
      return {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: { reasoning_text: data.delta as string },
            finish_reason: null,
          },
        ],
      };
    }

    case "response.output_item.done": {
      // A complete output item — could signal finish
      const item = data as Record<string, unknown>;
      if (item.type === "message") {
        return {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
        };
      }
      return null;
    }

    case "response.completed": {
      // Extract usage if present
      const response = data as Record<string, unknown>;
      const usage = response.usage as Record<string, unknown> | undefined;
      if (usage) {
        return {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: null,
            },
          ],
          usage: {
            prompt_tokens: usage.input_tokens ?? 0,
            completion_tokens: usage.output_tokens ?? 0,
            total_tokens:
              ((usage.input_tokens as number) ?? 0) +
              ((usage.output_tokens as number) ?? 0),
          },
        };
      }
      return null;
    }

    case "error": {
      // Forward error events
      return {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "error",
            error: data,
          },
        ],
      };
    }

    default:
      return null;
  }
}

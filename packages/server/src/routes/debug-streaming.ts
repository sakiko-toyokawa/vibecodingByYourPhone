import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createStreamCoordinator } from "../augments/stream-coordinator.js";

/**
 * Debug routes for testing streaming markdown rendering.
 * Uses the real StreamCoordinator to faithfully reproduce in-app behavior.
 */
export function createDebugStreamingRoutes(): Hono {
  const routes = new Hono();

  /**
   * POST /api/debug/stream-markdown
   * Streams markdown through the real StreamCoordinator, emitting SSE events.
   *
   * Body: { markdown: string, chunkSize?: number, delayMs?: number }
   * Events: markdown-augment, pending, done
   */
  routes.post("/stream-markdown", async (c) => {
    const body = await c.req.json<{
      markdown: string;
      chunkSize?: number;
      delayMs?: number;
    }>();

    const { markdown, chunkSize = 5, delayMs = 20 } = body;

    if (!markdown) {
      return c.json({ error: "markdown is required" }, 400);
    }

    return streamSSE(c, async (stream) => {
      let eventId = 0;
      const coordinator = await createStreamCoordinator();

      // Split markdown into chunks
      const chunks: string[] = [];
      for (let i = 0; i < markdown.length; i += chunkSize) {
        chunks.push(markdown.slice(i, i + chunkSize));
      }

      // Stream each chunk through the coordinator
      for (const chunk of chunks) {
        const result = await coordinator.onChunk(chunk);

        // Emit augments
        for (const augment of result.augments) {
          await stream.writeSSE({
            id: String(eventId++),
            event: "markdown-augment",
            data: JSON.stringify({
              blockIndex: augment.blockIndex,
              html: augment.html,
              type: augment.type,
            }),
          });
        }

        // Emit pending (always, even if empty, so client can clear it)
        await stream.writeSSE({
          id: String(eventId++),
          event: "pending",
          data: JSON.stringify({
            html: result.pendingHtml,
          }),
        });

        // Delay between chunks
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }

      // Flush any remaining content
      const flushResult = await coordinator.flush();
      for (const augment of flushResult.augments) {
        await stream.writeSSE({
          id: String(eventId++),
          event: "markdown-augment",
          data: JSON.stringify({
            blockIndex: augment.blockIndex,
            html: augment.html,
            type: augment.type,
          }),
        });
      }

      // Clear pending after flush
      await stream.writeSSE({
        id: String(eventId++),
        event: "pending",
        data: JSON.stringify({ html: "" }),
      });

      // Signal completion
      await stream.writeSSE({
        id: String(eventId++),
        event: "done",
        data: JSON.stringify({ totalEvents: eventId }),
      });
    });
  });

  return routes;
}

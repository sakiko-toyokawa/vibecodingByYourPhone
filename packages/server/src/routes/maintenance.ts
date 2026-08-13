import { Hono } from "hono";
import { z } from "zod";
import type { MaintenanceTargetStore } from "../loop/maintenance/index.js";
import type { TriggerQueueStore } from "../loop/state/trigger-queue-store.js";

const ExternalRefSchema = z.object({
  source: z.string().min(1),
  subject_id: z.string().min(1),
});

const MaintenanceEventSchema = z
  .object({
    source: z.string().min(1),
    event_id: z.string().min(1),
    target_id: z.string().optional(),
    external_ref: ExternalRefSchema.optional(),
    priority: z.enum(["urgent", "normal", "background"]).optional(),
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  .superRefine((body, ctx) => {
    if (!body.target_id && !body.external_ref) {
      ctx.addIssue({
        code: "custom",
        message: "target_id or external_ref is required",
        path: ["target_id"],
      });
    }
  });

const MaintenanceTargetCreateSchema = z.object({
  target_id: z.string().min(1),
  loop_id: z.string().min(1),
  target_type: z.string().min(1),
  external_ref: ExternalRefSchema,
  wake_policy: z.object({
    trigger_types: z.array(z.string().min(1)).min(1),
    max_repairs: z.number().int().min(1).default(3),
  }),
  context_payload: z.record(z.string(), z.unknown()).default({}),
  adapter_data: z.record(z.string(), z.unknown()).optional(),
});

export interface MaintenanceRoutesDeps {
  targetStore: MaintenanceTargetStore;
  triggerQueueStore?: TriggerQueueStore;
  drainPendingTriggers?: (loopId?: string) => Promise<void>;
}

export function createMaintenanceRoutes(deps: MaintenanceRoutesDeps): Hono {
  const app = new Hono();
  const { targetStore } = deps;

  app.get("/targets", (c) => {
    const loopId = c.req.query("loop_id");
    return c.json({ targets: targetStore.list(loopId) });
  });

  app.get("/targets/:id", (c) => {
    const target = targetStore.findById(c.req.param("id"));
    if (!target) {
      return c.json({ error: "target_not_found" }, 404);
    }
    return c.json({ target });
  });

  app.post("/targets", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = MaintenanceTargetCreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: "invalid_target",
          message: parsed.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
        },
        400,
      );
    }
    const now = new Date().toISOString();
    const existing = targetStore.findById(parsed.data.target_id);
    const target = await targetStore.upsert({
      ...(existing ?? {
        state: "waiting",
        feedback_cursor: {},
        feedback_count: 0,
        repair_count: 0,
        created_at: now,
      }),
      ...parsed.data,
      updated_at: now,
    });
    return c.json({ target }, 201);
  });

  app.post("/events", async (c) => {
    if (!deps.triggerQueueStore || !deps.drainPendingTriggers) {
      return c.json({ error: "trigger_queue_unavailable" }, 503);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = MaintenanceEventSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: "invalid_event",
          message: parsed.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
        },
        400,
      );
    }
    const data = parsed.data;
    const target = data.target_id
      ? targetStore.findById(data.target_id)
      : data.external_ref
        ? targetStore.findByExternalRef(
            data.external_ref.source,
            data.external_ref.subject_id,
          )
        : null;
    if (!target) {
      return c.json({ error: "target_not_found" }, 404);
    }
    if (target.state === "done") {
      return c.json(
        { error: "target_done", message: "target is no longer maintained" },
        409,
      );
    }
    await targetStore.updateState(target.target_id, "waking");
    const entry = await deps.triggerQueueStore.enqueue({
      event_id: data.event_id,
      loop_id: target.loop_id,
      source: "webhook",
      priority: data.priority,
      payload: {
        ...data.payload,
        maintenance_id: target.target_id,
        external_ref: target.external_ref,
      },
    });
    await deps.drainPendingTriggers(target.loop_id);
    return c.json(
      {
        accepted: true,
        event_id: entry.event_id,
        target_id: target.target_id,
        state: entry.state,
      },
      202,
    );
  });

  return app;
}

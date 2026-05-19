/**
 * /api/v1/managed_agents/agents/{agent_id}
 *
 * GET    — fetch one agent or 404.
 * PATCH  — partial update. We only touch the columns the user is actually
 *          changing (UpdateAgentBody fields are optional), so an empty
 *          PATCH is a no-op rather than a silent overwrite to defaults.
 */

import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { parseCronSpec } from "@/server/cron";
import { invalidateWarmTasks } from "@/server/memory";
import {
  encryptEnvVars,
  httpError,
  RESERVED_ENV_KEYS,
  toApiAgent,
  UpdateAgentBody,
} from "@/server/types";
import { wrap } from "@/server/route-helpers";
import type { Prisma } from "@prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ agent_id: string }>;
}

export const GET = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { agent_id } = await ctx.params;
  const row = await prisma.agent.findUnique({ where: { agent_id } });
  if (row === null) httpError(404, `agent '${agent_id}' not found`);
  return Response.json(toApiAgent(row));
});

export const PATCH = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { agent_id } = await ctx.params;
  const body = UpdateAgentBody.parse(await req.json());

  const data: Prisma.AgentUpdateInput = {};
  if (body.name !== undefined) data.agent_name = body.name;
  if (body.pfp_url !== undefined) data.pfp_url = body.pfp_url;
  if (body.mcp_servers !== undefined) data.mcp_servers = body.mcp_servers;
  if (body.harness_image !== undefined) data.task_definition_arn = body.harness_image;
  if (body.prompt !== undefined) data.prompt = body.prompt;
  if (body.model !== undefined) data.model = body.model;
  if (body.branch !== undefined) data.branch = body.branch;
  if (body.preload_memory_limit !== undefined) {
    data.preload_memory_limit = body.preload_memory_limit;
  }

  const existing = await prisma.agent.findUnique({ where: { agent_id } });
  if (existing === null) httpError(404, `agent '${agent_id}' not found`);

  // Cron fields. Schedule and timezone are validated *together* so the
  // user gets a single 400 on the bad pair rather than a misleading error
  // on whichever field happened to be evaluated first. When either changes
  // we recompute cron_next_fire_at so the next tick fires on the new
  // cadence — without this, an agent moved from "@daily" to "* * * * *"
  // would still wait until tomorrow before the next fire.
  //
  // Treat `""` as "clear the schedule" so the UI can drop the cron without
  // having to send `null` in JSON (which some clients normalize to undef).
  const wantsScheduleChange = body.cron_schedule !== undefined;
  const wantsTimezoneChange = body.cron_timezone !== undefined;
  if (wantsScheduleChange || wantsTimezoneChange) {
    const nextSchedule =
      wantsScheduleChange
        ? (body.cron_schedule === "" ? null : body.cron_schedule ?? null)
        : ((existing as unknown as Record<string, unknown>).cron_schedule as
            | string
            | null
            | undefined) ?? null;
    const nextTimezone =
      body.cron_timezone ??
      (((existing as unknown as Record<string, unknown>).cron_timezone as
        | string
        | undefined) ?? "UTC");
    let nextFire: Date | null = null;
    try {
      const parsed = parseCronSpec(nextSchedule, nextTimezone);
      nextFire = parsed.next;
    } catch (e) {
      httpError(400, e instanceof Error ? e.message : String(e));
    }
    // Cast through unknown — the generated Prisma client may not yet know
    // about the cron_* columns in pre-generate environments.
    const cronPatch = data as unknown as Record<string, unknown>;
    cronPatch.cron_schedule = nextSchedule;
    cronPatch.cron_timezone = nextTimezone;
    cronPatch.cron_next_fire_at = nextFire;
  }
  if (body.cron_enabled !== undefined) {
    const cronPatch = data as unknown as Record<string, unknown>;
    cronPatch.cron_enabled = body.cron_enabled;
    // Flipping enabled off doesn't clear cron_next_fire_at — that way
    // toggling back on resumes from the existing schedule without losing
    // the cadence. The tick query filters on cron_enabled = true, so the
    // disabled row is invisible to the scheduler regardless.
    //
    // Flipping enabled on with no schedule set is a no-op (the scheduler
    // also filters on cron_schedule IS NOT NULL). Don't error — letting
    // users pre-arm the toggle before adding a schedule is a fine UX.
  }
  if (body.cron_overlap_policy !== undefined) {
    const cronPatch = data as unknown as Record<string, unknown>;
    cronPatch.cron_overlap_policy = body.cron_overlap_policy;
  }

  // env_vars replace flow: user supplies the new user-editable map; we
  // preserve any reserved-key entries already on the row (e.g.
  // AGENT_REQUIREMENTS, which is set at create time and not user-editable).
  if (body.env_vars !== undefined) {
    const existingRaw =
      existing &&
      existing.env_vars &&
      typeof existing.env_vars === "object" &&
      !Array.isArray(existing.env_vars)
        ? (existing.env_vars as Record<string, unknown>)
        : {};
    const preserved: Record<string, string> = {};
    for (const [k, v] of Object.entries(existingRaw)) {
      if (RESERVED_ENV_KEYS.has(k)) {
        // Reserved keys are stored encrypted — keep the ciphertext as-is.
        preserved[k] = String(v);
      }
    }
    const reencrypted = encryptEnvVars(body.env_vars);
    data.env_vars = {
      ...preserved,
      ...reencrypted,
    } as Prisma.InputJsonValue;
  }

  const updated = await prisma.agent.update({ where: { agent_id }, data });
  // The pre-loaded AGENT_PROMPT is baked at warm-task spawn, so a fresh
  // preload_memory_limit only takes effect on the next bring-up. Without
  // recycling warm tasks here, a user shrinking the limit from 10 → 0
  // would still see 10 ranked rows in the next session if a warm pod gets
  // claimed. Cheap: warm pool reconciler refills in <2s.
  if (body.preload_memory_limit !== undefined) {
    await invalidateWarmTasks(agent_id);
  }
  return Response.json(toApiAgent(updated));
});

export const DELETE = wrap<RouteContext>(async (req, ctx) => {
  assertAuth(req);
  const { agent_id } = await ctx.params;
  const row = await prisma.agent.findUnique({ where: { agent_id } });
  if (row === null) httpError(404, `agent '${agent_id}' not found`);
  await prisma.agent.delete({ where: { agent_id } });
  return new Response(null, { status: 204 });
});

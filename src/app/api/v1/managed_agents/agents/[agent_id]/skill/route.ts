/**
 * POST /api/v1/managed_agents/agents/{agent_id}/skill
 *
 * Attach a skill to an agent by either referencing an existing skill or
 * providing inline content. Updates agent.prompt by appending a per-skill
 * block delimited by `<!-- skill:<skill_id> -->`. Multiple skills can be
 * stacked on one agent — each gets its own block, ordered by attach time.
 *
 * Body (one of):
 *   { skill_id: string }
 *     — attach an existing skill from the library by ID
 *
 *   { content: string, name?: string, description?: string, save_to_library?: boolean }
 *     — inline content. Always saved to the library first so we have an
 *       id for the marker. `save_to_library: false` is accepted for
 *       backward compatibility but is treated as a no-op (we always save).
 *
 * DELETE removes a skill block from agent.prompt.
 *   - With `?skill_id=<id>`: strip only that block.
 *   - Without param: strip all skill blocks (legacy "detach all").
 */

import { z } from "zod";
import { assertAuth } from "@/server/auth";
import { prisma } from "@/server/db";
import { httpError, toApiAgent, toApiSkill } from "@/server/types";
import { wrap } from "@/server/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ agent_id: string }>;
}

const AttachSkillBody = z.union([
  z.object({
    skill_id: z.string().min(1),
  }),
  z.object({
    content: z.string().min(1),
    name: z.string().optional(),
    description: z.string().optional(),
    save_to_library: z.boolean().optional(),
  }),
]);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Append a per-skill block to the prompt. Idempotent on skill_id — if a
 * block for this skill already exists, the prompt is returned unchanged.
 */
export function appendSkillBlock(
  prompt: string | null | undefined,
  skillId: string,
  skillContent: string,
): string {
  const current = (prompt ?? "").trimEnd();
  const markerRe = new RegExp(`(^|\\n)<!-- skill:${escapeRegex(skillId)} -->\\n`);
  if (markerRe.test(current)) {
    return current;
  }
  const block = `<!-- skill:${skillId} -->\n${skillContent.trim()}`;
  return current ? `${current}\n\n${block}` : block;
}

/** Strip a single skill block (matching skill_id) from the prompt. */
export function stripSkillBlock(
  prompt: string | null | undefined,
  skillId: string,
): string {
  const current = prompt ?? "";
  const re = new RegExp(
    `\\n?<!-- skill:${escapeRegex(skillId)} -->\\n[\\s\\S]*?(?=\\n<!-- skill:|$)`,
  );
  return current.replace(re, "").trimEnd();
}

/**
 * Strip every skill block from the prompt. Covers both the new
 * per-id marker (`<!-- skill:<id> -->`) and the legacy anonymous
 * `<!-- skill -->` marker used by earlier versions of this route.
 */
export function stripAllSkillBlocks(prompt: string | null | undefined): string {
  const current = prompt ?? "";
  // Legacy anonymous marker — everything after it was the single skill.
  const legacySplit = current.split(/\n<!-- skill -->\n/)[0];
  // New per-id markers — strip every block.
  return legacySplit
    .replace(/\n?<!-- skill:[^\s>]+ -->\n[\s\S]*?(?=\n<!-- skill:|$)/g, "")
    .trimEnd();
}

/** Parse the prompt and return attached skill_ids in marker order. */
export function parseAttachedSkillIds(prompt: string | null | undefined): string[] {
  const current = prompt ?? "";
  const ids: string[] = [];
  const re = /<!-- skill:([^\s>]+) -->/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(current)) !== null) {
    ids.push(m[1]);
  }
  return ids;
}

export const POST = wrap<RouteContext>(async (req, ctx) => {
  const { user_id } = assertAuth(req);
  const { agent_id } = await ctx.params;

  const agent = await prisma.agent.findUnique({ where: { agent_id } });
  if (agent === null || agent.created_by !== user_id) httpError(404, `agent '${agent_id}' not found`);

  const body = AttachSkillBody.parse(await req.json());

  let skillId: string;
  let skillContent: string;
  let savedSkill;

  if ("skill_id" in body) {
    const skill = await prisma.skill.findUnique({ where: { skill_id: body.skill_id } });
    if (skill === null || skill.created_by !== user_id) httpError(404, `skill '${body.skill_id}' not found`);
    skillId = skill.skill_id;
    skillContent = skill.content;
    savedSkill = toApiSkill(skill);
  } else {
    // Inline content — always save to the library so we have an id for
    // the marker. `save_to_library: false` is accepted but ignored;
    // simpler than carrying two code paths.
    const name = body.name?.trim() || `Skill ${new Date().toISOString().slice(0, 19)}`;
    const row = await prisma.skill.create({
      data: {
        name,
        description: body.description?.trim() ?? null,
        content: body.content,
        created_by: user_id,
      },
    });
    skillId = row.skill_id;
    skillContent = row.content;
    savedSkill = toApiSkill(row);
  }

  const updated = await prisma.agent.update({
    where: { agent_id },
    data: { prompt: appendSkillBlock(agent.prompt, skillId, skillContent) },
  });

  return Response.json({
    agent: toApiAgent(updated),
    ...(savedSkill ? { skill: savedSkill } : {}),
  }, { status: 200 });
});

export const DELETE = wrap<RouteContext>(async (req, ctx) => {
  const { user_id } = assertAuth(req);
  const { agent_id } = await ctx.params;

  const agent = await prisma.agent.findUnique({ where: { agent_id } });
  if (agent === null || agent.created_by !== user_id) httpError(404, `agent '${agent_id}' not found`);

  const url = new URL(req.url);
  const skillId = url.searchParams.get("skill_id");

  const nextPrompt = skillId
    ? stripSkillBlock(agent.prompt, skillId)
    : stripAllSkillBlocks(agent.prompt);

  const updated = await prisma.agent.update({
    where: { agent_id },
    data: { prompt: nextPrompt || null },
  });

  return Response.json({ agent: toApiAgent(updated) });
});

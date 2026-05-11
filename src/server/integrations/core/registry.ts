/**
 * Provider registry.
 *
 * Adding a new integration:
 *   1. Create `../providers/<id>/index.ts` exporting a default `Integration`.
 *   2. Add one import line below.
 *   3. Add it to the `ALL` array.
 *
 * That's the whole rule. No dynamic file scanning — explicit imports keep
 * the dependency tree obvious and play well with Next.js bundling.
 *
 * Per-agent model: every registered provider is always "available". Whether
 * a given agent can use the provider depends on whether the operator has
 * created an `AgentIntegrationConfig` row for that (agent, integration) pair.
 * The registry no longer filters by env-derived enabled state.
 */

import linear from "../providers/linear";
import type { Integration } from "./types";

const ALL: Integration[] = [linear];

/** Every registered provider. UI surfaces all of these as options. */
export function listProviders(): Integration[] {
  return [...ALL];
}

/** Lookup by id. Returns undefined if the id is unknown. */
export function getProvider(id: string): Integration | undefined {
  return ALL.find((x) => x.id === id);
}

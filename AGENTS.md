<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Debugging a stuck or slow session

When investigating a session that's stuck in `creating` or that took unexpectedly long, **start with the diagnose endpoint** instead of running a dozen kubectl / curl / log queries by hand:

```
GET /api/v1/managed_agents/sessions/{session_id}/diagnose
Authorization: Bearer $MASTER_KEY
```

It returns one JSON with: the session row, agent row, pod state, Sandbox CR, NodePort Service, last 200 lines of pod logs, the node's Ready/capacity/oversubscription status, the `harness-image-prepull` DaemonSet status on that node, the warm-pool counts for the agent, and a direct harness HTTP probe via the node's ExternalIP (which bypasses the platform's `_nodeHostCache`).

Read the `detected_issues` array first. Possible codes:
- `dead_node_assigned` — pod is scheduled on a node whose Ready condition is not "True"
- `stale_node_host_cache_suspect` — pod + service + harness are all fine, but the session has been `creating` for >120s. The platform's in-process `_nodeHostCache` is almost certainly stuck on a terminated node's IP. Restart the platform service to flush.
- `pod_image_pull_backoff` — `ImagePullBackOff` / `ErrImagePull` / `ErrImageNeverPull`
- `pod_not_ready_old` — pod has been not-Ready for >180s
- `harness_unreachable` — pod Running but harness HTTP probe fails
- `node_oversubscribed` — node's allocated CPU or memory requests >150% of capacity
- `service_missing` — pod exists, no `-np` Service
- `warm_pool_empty_for_agent` — this agent has 0 warm rows and `WARM_POOL_SIZE > 0`

If `detected_issues` is empty and the session is still stuck, the bring-up is mid-flight; check Render platform logs for the session_id.

The endpoint is implemented at `src/app/api/v1/managed_agents/sessions/[session_id]/diagnose/route.ts`. Add new detection codes there as new failure patterns surface.

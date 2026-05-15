# agent-templates/

Directory-based agent templates. Use this format when your template needs to ship real files into the sandbox (e.g. `~/.claude/settings.json`, `~/.gitconfig`).

For templates that only need a prompt and skill, add them directly to [`agent_templates.json`](../agent_templates.json) at the repo root — no directory needed.

## Structure

```
agent-templates/
  <template-id>/
    template.json   required
    <any files>     referenced by template.json "files" array
```

## template.json fields

```json
{
  "id": "my-template",
  "name": "Human-readable name",
  "description": "One-line description shown in the UI.",
  "icon": "🤖",
  "tags": ["tag1", "tag2"],
  "harness_id": "claude-agent-sdk",
  "model": "anthropic/claude-sonnet-4-6",

  "files": [
    {
      "template_path": "settings.json",
      "sandbox_path": "~/.claude/settings.json"
    }
  ],

  "prompt": "Optional system prompt.",
  "skill_name": "optional-skill-name",
  "skill": "Optional skill markdown.",
  "tools": ["gh CLI", "grep"],
  "requirements": null
}
```

`prompt`, `skill`, `skill_name`, `tools`, and `requirements` are all optional — omit any you don't need.

## How files get into the sandbox

At agent create time the platform reads each file listed in `files`, base64-encodes the content, and stores it as `LAP_FILE_N_DEST` / `LAP_FILE_N_CONTENT` env vars on the agent. When a session pod starts, `entrypoint.sh` decodes them and writes them to `sandbox_path` before handing off to the server. The agent process never sees the `LAP_FILE_*` vars.

`sandbox_path` supports `~` expansion (`~` → `/root`).

## Example

`claude-code-dangerously-allow-permissions/` ships a `settings.json` that sets `defaultMode: bypassPermissions` so Claude Code never asks for tool permissions:

```
agent-templates/
  claude-code-dangerously-allow-permissions/
    template.json
    settings.json   → written to ~/.claude/settings.json in the pod
```

# LiteLLM Agent Platform

LiteLLM Agent Platform lets anyone run a harness (Claude Code, Codex, Hermes) as a service. They select a harness, tools, and a system prompt, deploy it, and can start running and managing agents.

 
LiteLLM Agent Platform manages:
 
- **Unified interface for harnesses** - swap between Claude Code, Codex, Hermes, PI AI
- **Session management** - persistent agent sessions across runs
- **CRON schedules** - run agents on a schedule
- **Memory** - agents remember context across sessions

## Make an agent in the UI

The easy way. Non technical people can make agents too. Select a harness, attach your tools, set a system prompt, and deploy.

> _[ screenshot: select a harness ]_

1. **Select a harness.** Claude Code, Codex, Hermes, or OpenCode.
2. **Set it up.** Attach your tools and a system prompt. Your MCP servers and keys are already there from when you signed in.
3. **Deploy it.** One click. Then start running and managing agents from the UI or an API.

> _[ screenshot: set up the agent ]_

> _[ screenshot: deploy and run ]_

### Your tools are already connected

Add a key to the platform once. When you sign in, your GitHub and AWS MCPs are already there. You do not add them again. The agent just uses the keys.

## Make an agent with the API

Everything you can make in the UI you can make over the API.

### Create an agent

```bash
curl http://localhost:4000/agents -X POST \
  -H "Authorization: Bearer $LITELLM_KEY" \
  -d '{
    "name": "ci-fixer",
    "harness": "claude-code",
    "model": "anthropic/claude-sonnet-4-5",
    "system_prompt": "You monitor CI and fix failing checks.",
    "tools": ["github", "aws"]
  }'
```

### Run the agent

```bash
curl http://localhost:4000/agents/ci-fixer/runs -X POST \
  -H "Authorization: Bearer $LITELLM_KEY" \
  -d '{ "input": "Fix the failing CI check on PR #418" }'
```


## Supported Harnesses

- Claude Code
- Codex
- Hermes
- OpenCode


## Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

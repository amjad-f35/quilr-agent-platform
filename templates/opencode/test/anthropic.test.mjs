import assert from "node:assert/strict";
import test from "node:test";

import { createOpencodeEventTranslator, translateOpencodeEvent } from "../src/anthropic.mjs";

const ctx = { sessionId: "ses_123", model: "claude-sonnet-4-6" };

test("message deltas still translate to agent.message", () => {
  assert.deepEqual(
    translateOpencodeEvent(
      {
        id: "evt_delta_1",
        type: "message.part.delta",
        properties: {
          sessionID: "ses_123",
          messageID: "msg_assistant",
          partID: "prt_assistant",
          delta: { text: "hello" },
        },
      },
      ctx,
    ),
    {
      event: "agent.message",
      data: {
        id: "evt_delta_1",
        sessionID: "ses_123",
        messageID: "msg_assistant",
        partID: "prt_assistant",
        type: "agent.message",
        content: [{ type: "text", text: "hello" }],
        model: "claude-sonnet-4-6",
      },
    },
  );
});

test("reasoning part deltas translate to agent.thinking", () => {
  assert.deepEqual(
    translateOpencodeEvent(
      {
        type: "message.part.delta",
        properties: {
          sessionID: "ses_123",
          part: { type: "reasoning" },
          delta: { text: "I should inspect the code." },
        },
      },
      ctx,
    ),
    {
      event: "agent.thinking",
      data: {
        sessionID: "ses_123",
        type: "agent.thinking",
        thinking: "I should inspect the code.",
        content: [{ type: "thinking", text: "I should inspect the code." }],
        model: "claude-sonnet-4-6",
      },
    },
  );
});

test("thinking delta events translate to agent.thinking", () => {
  assert.deepEqual(
    translateOpencodeEvent(
      {
        type: "thinking_delta",
        properties: {
          sessionID: "ses_123",
          delta: { thinking: "Need a minimal patch." },
        },
      },
      ctx,
    ),
    {
      event: "agent.thinking",
      data: {
        sessionID: "ses_123",
        type: "agent.thinking",
        thinking: "Need a minimal patch.",
        content: [{ type: "thinking", text: "Need a minimal patch." }],
        model: "claude-sonnet-4-6",
      },
    },
  );
});

test("reasoning delta strings translate to agent.thinking", () => {
  assert.deepEqual(
    translateOpencodeEvent(
      {
        type: "reasoning-delta",
        properties: {
          sessionID: "ses_123",
          delta: "Try the narrow fix first.",
        },
      },
      ctx,
    ),
    {
      event: "agent.thinking",
      data: {
        sessionID: "ses_123",
        type: "agent.thinking",
        thinking: "Try the narrow fix first.",
        content: [{ type: "thinking", text: "Try the narrow fix first." }],
        model: "claude-sonnet-4-6",
      },
    },
  );
});

test("pending tool updates include stable id and name without empty input", () => {
  assert.deepEqual(
    translateOpencodeEvent(
      {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_123",
          part: {
            id: "part_tool_1",
            type: "tool",
            tool: "sandbox_exec",
            state: {
              status: "pending",
              input: {},
            },
          },
        },
      },
      ctx,
    ),
    {
      event: "agent.tool_use",
      data: {
        type: "agent.tool_use",
        id: "part_tool_1",
        name: "sandbox_exec",
        tool: "sandbox_exec",
        status: "pending",
      },
    },
  );
});

test("running tool updates include the current input", () => {
  assert.deepEqual(
    translateOpencodeEvent(
      {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_123",
          part: {
            id: "part_tool_1",
            type: "tool",
            tool: "sandbox_exec",
            state: {
              status: "running",
              input: { command: "echo \"hello world\"" },
            },
          },
        },
      },
      ctx,
    ),
    {
      event: "agent.tool_use",
      data: {
        type: "agent.tool_use",
        id: "part_tool_1",
        name: "sandbox_exec",
        tool: "sandbox_exec",
        input: { command: "echo \"hello world\"" },
        status: "running",
      },
    },
  );
});

test("completed tool updates translate to agent.tool_result with output", () => {
  assert.deepEqual(
    translateOpencodeEvent(
      {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_123",
          part: {
            id: "part_tool_1",
            type: "tool",
            tool: "sandbox_exec",
            state: {
              status: "completed",
              input: { command: "echo \"hello world\"" },
              output: "hello world\n",
            },
          },
        },
      },
      ctx,
    ),
    {
      event: "agent.tool_result",
      data: {
        type: "agent.tool_result",
        tool_use_id: "part_tool_1",
        name: "sandbox_exec",
        tool: "sandbox_exec",
        content: [{ type: "text", text: "hello world\n" }],
        output: "hello world\n",
      },
    },
  );
});

test("translator preserves unique delta ids for repeated text tokens", () => {
  const translate = createOpencodeEventTranslator(ctx);
  const first = translate({
    id: "evt_period_1",
    type: "message.part.delta",
    properties: {
      sessionID: "ses_123",
      messageID: "msg_assistant",
      delta: ".",
    },
  });
  const second = translate({
    id: "evt_period_2",
    type: "message.part.delta",
    properties: {
      sessionID: "ses_123",
      messageID: "msg_assistant",
      delta: ".",
    },
  });

  assert.equal(first.data.id, "evt_period_1");
  assert.equal(second.data.id, "evt_period_2");
  assert.equal(first.data.content[0].text, ".");
  assert.equal(second.data.content[0].text, ".");
});

test("translator reconstructs user messages from updated message parts", () => {
  const translate = createOpencodeEventTranslator(ctx);
  assert.equal(
    translate({
      id: "evt_user_message",
      type: "message.updated",
      properties: {
        sessionID: "ses_123",
        message: { id: "msg_user", role: "user" },
      },
    }),
    null,
  );

  assert.deepEqual(
    translate({
      id: "evt_user_text",
      type: "message.part.updated",
      properties: {
        sessionID: "ses_123",
        part: {
          id: "prt_user",
          messageID: "msg_user",
          type: "text",
          text: "remember 42",
        },
      },
    }),
    {
      event: "user.message",
      data: {
        id: "evt_user_text",
        sessionID: "ses_123",
        messageID: "msg_user",
        partID: "prt_user",
        type: "user.message",
        content: [{ type: "text", text: "remember 42" }],
      },
    },
  );
});

test("events for another session are dropped", () => {
  assert.equal(
    translateOpencodeEvent(
      {
        type: "thinking_delta",
        properties: {
          sessionID: "ses_other",
          delta: { thinking: "not this session" },
        },
      },
      ctx,
    ),
    null,
  );
});

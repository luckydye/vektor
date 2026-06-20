import { describe, expect, it } from "bun:test";
import type { Bash } from "just-bash";
import { runAgentPrompt } from "../src/agent/core.ts";
import type { ChatMessage } from "../src/provider/types.ts";

const provider = {
  provider: "ollama" as const,
  baseUrl: "http://unused.invalid",
  model: "test",
};

describe("agent model loop", () => {
  it("retries an empty completion and executes the subsequent tool call", async () => {
    const responses: Array<{ message: ChatMessage; finishReason: string }> = [
      { message: { role: "assistant", content: null }, finishReason: "stop" },
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "bash",
                arguments: JSON.stringify({ command: "js-exec -c 'console.log(2 + 2)'" }),
              },
            },
          ],
        },
        finishReason: "tool_calls",
      },
      {
        message: { role: "assistant", content: "JavaScript returned 4." },
        finishReason: "stop",
      },
    ];
    const commands: string[] = [];
    const events: string[] = [];
    const bash = {
      exec: async (command: string) => {
        commands.push(command);
        return { stdout: "4\n", stderr: "", exitCode: 0 };
      },
    } as unknown as Bash;

    const result = await runAgentPrompt({
      messages: [{ role: "user", content: "Run JavaScript" }],
      apiUrl: "http://unused.invalid",
      spaceId: "space",
      jobToken: "token",
      provider,
      bash,
      modelCaller: async (options) => {
        const response = responses.shift();
        if (!response) throw new Error("No mock model response remaining");
        if (response.message.content) {
          await options.onText?.(response.message.content);
        }
        return response;
      },
      onEvent: (event) => events.push(event.type),
    });

    expect(commands).toEqual(["js-exec -c 'console.log(2 + 2)'"]);
    expect(events).toEqual(["status", "tool_call", "tool_result", "text"]);
    expect(result.content).toBe("JavaScript returned 4.");
  });

  it("fails visibly after repeated empty completions", async () => {
    const bash = {
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    } as unknown as Bash;

    await expect(
      runAgentPrompt({
        messages: [{ role: "user", content: "Run JavaScript" }],
        apiUrl: "http://unused.invalid",
        spaceId: "space",
        jobToken: "token",
        provider,
        bash,
        modelCaller: async () => ({
          message: { role: "assistant", content: null },
          finishReason: "stop",
        }),
      }),
    ).rejects.toThrow("empty response 3 times");
  });
});

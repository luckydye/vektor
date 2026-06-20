import { defineCommand } from "just-bash";
import { callAnthropic } from "../../provider/anthropic.ts";
import { callOllama } from "../../provider/ollama.ts";
import { callOpenRouter } from "../../provider/openrouter.ts";
import type { AIProvider } from "../../provider/types.ts";

export function aiCommand(completion?: AIProvider) {
  return defineCommand("ai", async (args, ctx) => {
    if (!completion) {
      return { stdout: "", stderr: "ai: completion not configured\n", exitCode: 1 };
    }
    const prompt = args.join(" ") || ctx.stdin;
    if (!prompt.trim()) {
      return {
        stdout: "",
        stderr: "usage: ai <prompt> or echo <prompt> | ai\n",
        exitCode: 2,
      };
    }

    const messages = [{ role: "user" as const, content: prompt }];
    let result: { message: { content?: string | null }; finishReason: string };

    if (completion.provider === "anthropic") {
      result = await callAnthropic({ provider: completion, messages, tools: [] });
    } else if (completion.provider === "ollama") {
      result = await callOllama({ provider: completion, messages, tools: [] });
    } else {
      result = await callOpenRouter({ provider: completion, messages, tools: [] });
    }

    return { stdout: `${result.message.content ?? ""}\n`, stderr: "", exitCode: 0 };
  });
}

import { defineCommand } from "just-bash";
import {
  type AIProvider,
  getOpenAICompatibleChatCompletionsUrl,
  getOpenAICompatibleHeaders,
} from "../core.ts";

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
    let text: string;
    if (completion.provider === "anthropic") {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": completion.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: completion.model,
          max_tokens: 8192,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!response.ok) {
        throw new Error(`Anthropic ${response.status}: ${await response.text()}`);
      }
      const data = (await response.json()) as {
        content: Array<{ type: string; text?: string }>;
      };
      text = data.content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
    } else if (completion.provider === "ollama") {
      const response = await fetch(`${completion.baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: completion.model,
          messages: [{ role: "user", content: prompt }],
          stream: false,
          think: true,
        }),
      });
      if (!response.ok) {
        throw new Error(`Ollama ${response.status}: ${await response.text()}`);
      }
      const data = (await response.json()) as { message?: { content?: string } };
      text = data.message?.content ?? "";
    } else {
      const response = await fetch(getOpenAICompatibleChatCompletionsUrl(completion), {
        method: "POST",
        headers: getOpenAICompatibleHeaders(completion),
        body: JSON.stringify({
          model: completion.model,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!response.ok) {
        const label = completion.provider === "openrouter" ? "OpenRouter" : "Ollama";
        throw new Error(`${label} ${response.status}: ${await response.text()}`);
      }
      const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      text = data.choices[0]?.message?.content ?? "";
    }
    return { stdout: `${text}\n`, stderr: "", exitCode: 0 };
  });
}

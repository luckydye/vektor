import type { APIRoute } from "astro";
import {
  errorResponse,
  parseJsonBody,
  unauthorizedResponse,
  withApiErrorHandling,
} from "#db/api.ts";
import { verifyJobToken } from "../../../../jobs/jobToken.ts";
import { config } from "../../../../config.ts";

export const POST: APIRoute = (context) =>
  withApiErrorHandling(
    async () => {
      if (!context.locals.user) {
        const jobToken = context.request.headers.get("X-Job-Token");
        const spaceId = context.request.headers.get("X-Space-Id");
        if (!jobToken || !spaceId || !verifyJobToken(jobToken, spaceId)) {
          throw unauthorizedResponse();
        }
      }

      const apiKey = config().OPENROUTER_API_KEY;
      if (!apiKey) throw new Error("OPENROUTER_API_KEY not configured");
      const model = config().OPENROUTER_MODEL || "qwen/qwen3.5-397b-a17b";

      const bodyJson = await parseJsonBody(context.request);
      bodyJson.model = model;

      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(bodyJson),
        signal: context.request.signal,
      });

      return new Response(response.body, {
        status: response.status,
        headers: {
          "Content-Type": response.headers.get("Content-Type") ?? "application/json",
          "Cache-Control": "no-cache",
        },
      });
    },
    {
      fallbackMessage: "Proxy request failed",
      onError: () => errorResponse("Proxy request failed", 500),
    },
  );

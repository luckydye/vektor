import type { APIRoute } from "astro";
import { getAIProvider } from "#agent/core.ts";
import {
  errorResponse,
  parseJsonBody,
  unauthorizedResponse,
  withApiErrorHandling,
} from "#db/api.ts";
import { verifyJobToken } from "#jobs/jobToken.ts";
import { appLogger } from "#observability/logger.ts";
import { proxyToAnthropic } from "#provider/anthropic.ts";
import { proxyToOllama } from "#provider/ollama.ts";
import { getOpenAICompatibleChatCompletionsUrl } from "#provider/openrouter.ts";

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

      const provider = getAIProvider();
      const bodyJson = await parseJsonBody(context.request);

      if (provider.provider === "anthropic") {
        return proxyToAnthropic(provider.apiKey, provider.model, bodyJson, context.request.signal);
      }
      if (provider.provider === "ollama") {
        return proxyToOllama(provider.baseUrl, provider.model, bodyJson, context.request.signal);
      }

      bodyJson.model = provider.model;
      const response = await fetch(getOpenAICompatibleChatCompletionsUrl(provider), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify(bodyJson),
        signal: context.request.signal,
      });

      await logChatCompletionUpstreamFailure(provider.provider, provider.model, response);

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
      onError: (error) => {
        appLogger.error("Chat completions proxy failed", {
          error,
        });
        return errorResponse("Proxy request failed", 500);
      },
    },
  );

async function logChatCompletionUpstreamFailure(
  provider: string,
  model: string,
  response: Response,
): Promise<void> {
  if (response.ok) {
    return;
  }

  let responseBody: string;
  try {
    responseBody = await response.clone().text();
  } catch (error) {
    responseBody =
      error instanceof Error
        ? `failed to read upstream body: ${error.message}`
        : "failed to read upstream body";
  }

  appLogger.error("Chat completions upstream error", {
    provider,
    model,
    statusCode: response.status,
    contentType: response.headers.get("Content-Type"),
    body: responseBody.slice(0, 2000),
  });
}


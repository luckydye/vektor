import { defineMiddleware } from "astro:middleware";
import { resolveRequestIdentity } from "./acl/session.ts";
import { getPublicEnv } from "./config.ts";
import { appLogger } from "./observability/logger.ts";
import { runWithLang } from "./utils/langScope.server.ts";

export const onRequest = defineMiddleware(async (context, next) => {
  const startTime = Date.now();
  const requestTime = new Date(startTime).toString();
  const { request } = context;
  const url = new URL(request.url);

  context.locals.publicEnv = getPublicEnv();

  appLogger.info("HTTP request", {
    method: request.method,
    host: url.hostname,
    path: url.pathname,
    time: requestTime,
  });

  const { user, session } = await resolveRequestIdentity(request.headers);
  context.locals.user = user;
  context.locals.session = session;
  try {
    // Everything the render awaits sees this request's locale, and only this
    // request's — see `langScope.server.ts` for why a plain variable is not
    // enough here.
    const response = await runWithLang(context.preferredLocale, next);
    const durationMs = Date.now() - startTime;
    const attributes = {
      method: request.method,
      host: url.hostname,
      path: url.pathname,
      statusCode: response.status,
      durationMs,
    };

    if (response.status >= 500) {
      appLogger.error("HTTP response", attributes);
    } else if (response.status >= 400) {
      appLogger.warn("HTTP response", attributes);
    } else {
      appLogger.info("HTTP response", attributes);
    }

    return response;
  } catch (error) {
    const durationMs = Date.now() - startTime;
    appLogger.error("HTTP response failed", {
      method: request.method,
      host: url.hostname,
      path: url.pathname,
      durationMs,
      error,
    });
    throw error;
  }
});

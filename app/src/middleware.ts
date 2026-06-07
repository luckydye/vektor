import "./observability/bootstrap.ts";
import { defineMiddleware } from "astro:middleware";
import { auth } from "./auth.ts";
import { getPublicEnv } from "./config.ts";
import { isNoAuthMode, LOCAL_SESSION, LOCAL_USER } from "./noAuth.ts";
import { appLogger } from "./observability/logger.ts";

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

  if (isNoAuthMode()) {
    context.locals.user = LOCAL_USER as typeof context.locals.user;
    context.locals.session = LOCAL_SESSION as typeof context.locals.session;
  } else {
    const isAuthed = await auth.api.getSession({
      headers: request.headers,
    });
    if (isAuthed) {
      context.locals.user = isAuthed.user;
      context.locals.session = isAuthed.session;
    } else {
      context.locals.user = null;
      context.locals.session = null;
    }
  }
  try {
    const response = await next();
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

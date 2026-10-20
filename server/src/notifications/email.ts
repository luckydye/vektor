import { config } from "#config";
import { appLogger } from "#observability/logger.ts";
import type { Platform } from "#platform/platform.ts";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export function isEmailDeliveryAvailable(platform: Platform): boolean {
  return (
    platform.mailer.available() || import.meta.env.DEV || config().NODE_ENV === "test"
  );
}

export async function sendEmail(
  platform: Platform,
  message: EmailMessage,
): Promise<void> {
  if (platform.mailer.available()) {
    await platform.mailer.send(message);
    return;
  }

  if (!import.meta.env.DEV && config().NODE_ENV !== "test") {
    throw new Error("Email delivery is not configured");
  }

  appLogger.info("Development email delivery", {
    to: message.to,
    subject: message.subject,
  });
}

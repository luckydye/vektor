import { createTransport, type Transporter } from "nodemailer";
import { config } from "#config";
import { appLogger } from "#observability/logger.ts";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

let smtpTransport: Transporter | null = null;

function configuredTransport(): Transporter | null {
  const appConfig = config();
  const host = appConfig.SMTP_HOST?.trim();
  const from = appConfig.EMAIL_FROM?.trim();
  if (!host || !from) return null;
  if (smtpTransport) return smtpTransport;

  const secure = appConfig.SMTP_SECURE === "1" || appConfig.SMTP_SECURE === "true";
  const port = Number.parseInt(appConfig.SMTP_PORT || (secure ? "465" : "587"), 10);
  const user = appConfig.SMTP_USER?.trim();
  const password = appConfig.SMTP_PASSWORD;

  smtpTransport = createTransport({
    host,
    port,
    secure,
    ...(user && password ? { auth: { user, pass: password } } : {}),
  });
  return smtpTransport;
}

export function isEmailDeliveryAvailable(): boolean {
  return !!configuredTransport() || import.meta.env.DEV || config().NODE_ENV === "test";
}

export async function sendEmail(message: EmailMessage): Promise<void> {
  const transport = configuredTransport();
  const from = config().EMAIL_FROM?.trim();
  if (transport && from) {
    await transport.sendMail({
      from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
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

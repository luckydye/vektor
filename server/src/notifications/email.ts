import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createTransport, type Transporter } from "nodemailer";
import { config } from "#config";
import { appLogger } from "#observability/logger.ts";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

type TlsMode = "starttls" | "implicit" | "off";

/** Standard port of each mode: submission, SMTPS, plain SMTP. */
const MODE_PORT: Record<TlsMode, number> = { starttls: 587, implicit: 465, off: 25 };

let smtpTransport: Transporter | null = null;

function tlsMode(raw: string | undefined): TlsMode {
  const mode = raw?.trim().toLowerCase() || "starttls";
  if (mode !== "starttls" && mode !== "implicit" && mode !== "off") {
    throw new Error(
      `VEKTOR_SMTP_TLS must be "starttls", "implicit" or "off", got "${raw}"`,
    );
  }
  return mode;
}

function smtpPort(mode: TlsMode, raw: string | undefined): number {
  const configured = raw?.trim();
  if (!configured) return MODE_PORT[mode];

  const port = Number.parseInt(configured, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`VEKTOR_SMTP_PORT must be a port number, got "${raw}"`);
  }

  // Mismatched mode and port fail as a bogus certificate error rather than as a
  // protocol error: the plaintext SMTP greeting is read as a TLS ServerHello.
  if (mode === "implicit" && (port === 587 || port === 25)) {
    throw new Error(
      `VEKTOR_SMTP_TLS=implicit cannot be used with VEKTOR_SMTP_PORT=${port}, which expects an upgrade; use port 465 or VEKTOR_SMTP_TLS=starttls`,
    );
  }
  if (mode !== "implicit" && port === 465) {
    throw new Error(
      `VEKTOR_SMTP_TLS=${mode} cannot be used with VEKTOR_SMTP_PORT=465, which expects a TLS handshake from the first byte; use VEKTOR_SMTP_TLS=implicit`,
    );
  }

  return port;
}

function read(path: string, setting: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`${setting} is unreadable at ${path}: ${(error as Error).message}`);
  }
}

function trustedCertificates(
  file: string | undefined,
  dir: string | undefined,
): string[] | undefined {
  if (!file && !dir) return undefined;

  const certificates: string[] = [];
  if (file) {
    certificates.push(read(file, "VEKTOR_SMTP_CA_FILE"));
  }
  if (dir) {
    // A CA directory names its files unpredictably (hash symlinks, mixed
    // extensions), so read every entry and keep what turns out to be a PEM.
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) continue;
      const pem = read(join(dir, entry.name), "VEKTOR_SMTP_CA_DIR");
      if (pem.includes("BEGIN CERTIFICATE")) certificates.push(pem);
    }
  }

  if (!certificates.length) {
    throw new Error(`No CA certificates found in VEKTOR_SMTP_CA_DIR (${dir})`);
  }
  return certificates;
}

function configuredTransport(): Transporter | null {
  const appConfig = config();
  const host = appConfig.SMTP_HOST?.trim();
  const from = appConfig.EMAIL_FROM?.trim();
  if (!host || !from) return null;
  if (smtpTransport) return smtpTransport;

  const mode = tlsMode(appConfig.SMTP_TLS);
  const port = smtpPort(mode, appConfig.SMTP_PORT);
  const user = appConfig.SMTP_USER?.trim();
  const password = appConfig.SMTP_PASSWORD;
  const servername = appConfig.SMTP_TLS_SERVERNAME?.trim();
  const verify =
    appConfig.SMTP_TLS_VERIFY !== "0" && appConfig.SMTP_TLS_VERIFY !== "false";
  const ca = trustedCertificates(
    appConfig.SMTP_CA_FILE?.trim(),
    appConfig.SMTP_CA_DIR?.trim(),
  );

  if (mode === "off") {
    appLogger.warn(
      "SMTP encryption is disabled; credentials and mail are sent in the clear",
      {
        host,
        port,
      },
    );
  } else if (!verify) {
    appLogger.warn("SMTP certificate verification is disabled", { host, port });
  }

  smtpTransport = createTransport({
    host,
    port,
    secure: mode === "implicit",
    requireTLS: mode === "starttls",
    ignoreTLS: mode === "off",
    ...(user && password ? { auth: { user, pass: password } } : {}),
    tls: {
      rejectUnauthorized: verify,
      ...(servername ? { servername } : {}),
      ...(ca ? { ca } : {}),
    },
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

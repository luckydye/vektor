import { unzipExtensionPackage } from "#extensions/packageCache.ts";

export interface ExtensionRouteMenuItem {
  title: string;
  icon?: string;
}

/** @deprecated Use "standalone". Kept so existing extension manifests continue to work. */
export type DeprecatedPageExtensionPlacement = "page";

export interface ExtensionRoute {
  path: string;
  title?: string;
  description?: string;
  menuItem?: ExtensionRouteMenuItem;
  placements?: Array<
    "standalone" | "inline" | "document" | "database" | DeprecatedPageExtensionPlacement
  >;
}

export interface JobIOField {
  type: "string" | "number" | "boolean" | "object" | "file" | "blob";
  required?: boolean;
  /** What the value means, shown to the agent and in workflow tooling. */
  description?: string;
}

export interface JobDefinition {
  id: string;
  name: string;
  /** What the job does, shown to the agent so it can pick and call the job. */
  description?: string;
  entry: string;
  inputs?: Record<string, JobIOField>;
  outputs?: Record<string, JobIOField>;
}

export interface ExtensionIntegrationProfile {
  /** Response fields tried in order for the external account id. */
  accountId: string[];
  /** Response fields tried in order for a display name. */
  username?: string[];
}

export interface ExtensionIntegrationAgent {
  /** Appended to the agent system prompt while a user has the provider connected. */
  instructions?: string;
  /** A shell command for the agent, implemented by a job in manifest.jobs. */
  command?: { name: string; jobId: string };
}

/**
 * A model API the integration's access token pays for. While a user has the
 * integration connected and a model picked, their agent chats run on it
 * instead of the instance's provider.
 */
export interface ExtensionIntegrationAI {
  format: "openai-responses";
  /** Resolved against the provider origin like proxied requests, e.g. "/v1/responses". */
  path: string;
  /** Lists the models the account may use, e.g. "/v1/models". */
  modelsPath: string;
}

/**
 * For providers that register a client per user: the authorization redirect
 * carries this instance's stable host id, and the callback carries the issued
 * `client_id`, which the token exchange and every refresh use from then on.
 */
export interface ExtensionIntegrationRegistration {
  hostIdParam: string;
}

/**
 * An OAuth provider an extension contributes. The server runs the flow; the
 * manifest only describes the endpoints, and `{instance}` in any of them is
 * replaced with the operator-configured instance URL.
 */
export interface ExtensionIntegration {
  id: string;
  label: string;
  description?: string;
  authorizationUrl: string;
  tokenUrl: string;
  /** Without it, the profile fields are read from the token response's `id_token`. */
  userInfoUrl?: string;
  /**
   * A public client id. The provider then needs no operator credentials, and
   * the flow runs as a public PKCE client without a client secret.
   */
  clientId?: string;
  /**
   * A fixed redirect URI for providers that only accept loopback addresses.
   * The browser lands on a page that does not load, and the user pastes its
   * address back into Vektor to finish connecting.
   */
  redirectUri?: string;
  registration?: ExtensionIntegrationRegistration;
  /** Extra form parameters for the token exchange and refresh. */
  tokenParams?: Record<string, string>;
  /** Where the user manages the connected account's usage. */
  manageUrl?: string;
  ai?: ExtensionIntegrationAI;
  scopes?: string[];
  /** Instance URL used when the operator configures none. */
  defaultInstanceUrl?: string;
  /** Every proxied request is forced under this path, e.g. "/api/v4". */
  apiBasePath?: string;
  /**
   * Extra query parameters for the authorization redirect. Providers that only
   * hand out a refresh token when asked need this — Google, for one, returns
   * none without `access_type=offline`.
   */
  authorizationParams?: Record<string, string>;
  profile: ExtensionIntegrationProfile;
  agent?: ExtensionIntegrationAgent;
}

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  entries: {
    frontend?: string;
    view?: string;
  };
  routes?: ExtensionRoute[];
  jobs?: JobDefinition[];
  integrations?: ExtensionIntegration[];
}

/** Unpacked package contents, keyed by the archive path of each entry. */
type ZipFiles = Record<string, Uint8Array>;

function normaliseZipPath(filePath: string): string {
  const normalised = filePath.replace(/^\.?\//, "").trim();
  if (!normalised || normalised.includes("..")) {
    throw new Error(`Invalid extension asset path: '${filePath}'`);
  }
  return normalised;
}

/**
 * Look an entry up by archive path. The requested path is normalised (which
 * rejects traversal), and entry names only have a leading "./" stripped — an
 * entry whose own name escapes the archive can therefore never be matched.
 */
function findZipEntry(files: ZipFiles, filePath: string): Uint8Array | undefined {
  const normalisedPath = normaliseZipPath(filePath);
  for (const [name, data] of Object.entries(files)) {
    if (name.replace(/^\.?\//, "").trim() === normalisedPath) return data;
  }
  return undefined;
}

/**
 * Unpack a package. Anything fflate cannot read (truncated upload, not a ZIP)
 * and anything past the decompressed-size limits throws; the upload route turns
 * that into a "Invalid extension package: …" bad-request, so the message here is
 * the bare cause.
 */
function unzipPackage(buffer: Buffer): ZipFiles {
  try {
    return unzipExtensionPackage(buffer);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

function resolveMenuIcon(icon: string, files: ZipFiles): string {
  try {
    const trimmedIcon = icon.trim();

    if (trimmedIcon.startsWith("<svg")) {
      return trimmedIcon;
    }

    const normalisedPath = normaliseZipPath(trimmedIcon);
    if (!normalisedPath.toLowerCase().endsWith(".svg")) {
      console.warn(
        `Ignoring extension menu icon '${trimmedIcon}': icon must be inline SVG or a .svg asset path`,
      );
      return "";
    }

    const iconFile = findZipEntry(files, normalisedPath);
    if (!iconFile) {
      console.warn(
        `Ignoring extension menu icon '${trimmedIcon}': referenced file was not found in package`,
      );
      return "";
    }

    const svgContent = Buffer.from(iconFile).toString("utf-8").trim();
    if (!svgContent.startsWith("<svg")) {
      console.warn(
        `Ignoring extension menu icon '${trimmedIcon}': file content is not SVG`,
      );
      return "";
    }

    return svgContent;
  } catch (err) {
    console.warn(`Ignoring extension menu icon '${icon}':`, err);
    return "";
  }
}

const INTEGRATION_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Parameters the server derives itself. A manifest that could overwrite `state`
 * or the PKCE challenge could disarm both, so an extension may only add
 * parameters the flow does not depend on.
 */
const RESERVED_AUTHORIZATION_PARAMS = new Set([
  "response_type",
  "client_id",
  "client_secret",
  "redirect_uri",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
]);

/** The token exchange's own parameters, which `tokenParams` may not overwrite. */
const RESERVED_TOKEN_PARAMS = new Set([
  "grant_type",
  "code",
  "code_verifier",
  "client_id",
  "client_secret",
  "redirect_uri",
  "refresh_token",
]);

function validateParams(
  integration: ExtensionIntegration,
  field: "authorizationParams" | "tokenParams",
  reserved: Set<string>,
): void {
  const params = integration[field];
  if (params === undefined) return;

  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error(
      `Extension manifest integration '${integration.id}' has an invalid '${field}'`,
    );
  }

  for (const [name, value] of Object.entries(params)) {
    if (reserved.has(name.toLowerCase())) {
      throw new Error(
        `Extension manifest integration '${integration.id}' may not set the reserved parameter '${name}' in '${field}'`,
      );
    }
    if (typeof value !== "string") {
      throw new Error(
        `Extension manifest integration '${integration.id}' parameter '${name}' in '${field}' must be a string`,
      );
    }
  }
}

function validateOptionalStrings(
  integration: ExtensionIntegration,
  fields: Array<"userInfoUrl" | "clientId" | "redirectUri" | "manageUrl">,
): void {
  for (const field of fields) {
    const value = integration[field];
    if (value !== undefined && (typeof value !== "string" || !value.trim())) {
      throw new Error(
        `Extension manifest integration '${integration.id}' has an invalid '${field}'`,
      );
    }
  }
}

function validateRegistration(integration: ExtensionIntegration): void {
  const registration = integration.registration;
  if (registration === undefined) return;

  const hostIdParam = registration?.hostIdParam;
  if (typeof hostIdParam !== "string" || !hostIdParam.trim()) {
    throw new Error(
      `Extension manifest integration '${integration.id}' registration is missing 'hostIdParam'`,
    );
  }
  if (
    RESERVED_AUTHORIZATION_PARAMS.has(hostIdParam.toLowerCase()) ||
    Object.hasOwn(integration.authorizationParams ?? {}, hostIdParam)
  ) {
    throw new Error(
      `Extension manifest integration '${integration.id}' registration 'hostIdParam' collides with another authorization parameter`,
    );
  }
  if (!integration.clientId) {
    throw new Error(
      `Extension manifest integration '${integration.id}' registration needs the 'clientId' it registers with`,
    );
  }
}

function validateAI(integration: ExtensionIntegration): void {
  const ai = integration.ai;
  if (ai === undefined) return;

  if (ai?.format !== "openai-responses") {
    throw new Error(
      `Extension manifest integration '${integration.id}' ai 'format' must be "openai-responses"`,
    );
  }
  for (const field of ["path", "modelsPath"] as const) {
    if (typeof ai[field] !== "string" || !ai[field].startsWith("/")) {
      throw new Error(
        `Extension manifest integration '${integration.id}' ai '${field}' must be an absolute path`,
      );
    }
  }
}

/**
 * Integrations are how a provider reaches the OAuth routes, so a malformed one
 * has to fail the install rather than surface as a half-configured provider.
 */
function validateIntegrations(manifest: ExtensionManifest): void {
  const integrations = manifest.integrations;
  if (!Array.isArray(integrations)) {
    throw new Error("Extension manifest 'integrations' must be an array");
  }

  const seen = new Set<string>();
  for (const integration of integrations) {
    if (!integration || typeof integration !== "object") {
      throw new Error("Extension manifest contains an invalid integration");
    }
    if (
      typeof integration.id !== "string" ||
      !INTEGRATION_ID_PATTERN.test(integration.id)
    ) {
      throw new Error(
        "Extension manifest integration id must be lowercase alphanumeric with hyphens",
      );
    }
    if (seen.has(integration.id)) {
      throw new Error(
        `Extension manifest declares integration '${integration.id}' twice`,
      );
    }
    seen.add(integration.id);

    if (typeof integration.label !== "string" || !integration.label.trim()) {
      throw new Error(
        `Extension manifest integration '${integration.id}' is missing required 'label' field`,
      );
    }
    for (const field of ["authorizationUrl", "tokenUrl"] as const) {
      if (typeof integration[field] !== "string" || !integration[field].trim()) {
        throw new Error(
          `Extension manifest integration '${integration.id}' is missing required '${field}' field`,
        );
      }
    }
    if (
      !integration.profile ||
      !Array.isArray(integration.profile.accountId) ||
      integration.profile.accountId.length === 0
    ) {
      throw new Error(
        `Extension manifest integration '${integration.id}' needs 'profile.accountId' naming at least one response field`,
      );
    }

    validateOptionalStrings(integration, [
      "userInfoUrl",
      "clientId",
      "redirectUri",
      "manageUrl",
    ]);
    validateParams(integration, "authorizationParams", RESERVED_AUTHORIZATION_PARAMS);
    validateParams(integration, "tokenParams", RESERVED_TOKEN_PARAMS);
    validateRegistration(integration);
    validateAI(integration);

    const commandJobId = integration.agent?.command?.jobId;
    if (commandJobId && !manifest.jobs?.some((job) => job.id === commandJobId)) {
      throw new Error(
        `Extension manifest integration '${integration.id}' names agent command job '${commandJobId}', which is not in 'jobs'`,
      );
    }
    if (integration.agent?.command && !integration.agent.command.name?.trim()) {
      throw new Error(
        `Extension manifest integration '${integration.id}' agent command is missing 'name'`,
      );
    }
  }
}

export function extractFile(zipBuffer: Buffer, filePath: string): Buffer | null {
  const file = findZipEntry(unzipPackage(zipBuffer), filePath);
  return file ? Buffer.from(file) : null;
}

export function extractManifest(zipBuffer: Buffer): ExtensionManifest {
  const files = unzipPackage(zipBuffer);
  const manifestFile = findZipEntry(files, "manifest.json");

  if (!manifestFile) {
    throw new Error("Extension package missing manifest.json");
  }

  const manifestText = Buffer.from(manifestFile).toString("utf-8");
  const manifest = JSON.parse(manifestText) as ExtensionManifest;

  if (!manifest.id || typeof manifest.id !== "string") {
    throw new Error("Extension manifest missing required 'id' field");
  }
  if (!manifest.name || typeof manifest.name !== "string") {
    throw new Error("Extension manifest missing required 'name' field");
  }
  if (!manifest.version || typeof manifest.version !== "string") {
    throw new Error("Extension manifest missing required 'version' field");
  }
  if (!manifest.entries || typeof manifest.entries !== "object") {
    throw new Error("Extension manifest missing required 'entries' field");
  }

  if (manifest.routes !== undefined) {
    if (!Array.isArray(manifest.routes)) {
      throw new Error("Extension manifest 'routes' must be an array");
    }
    for (const [index, route] of manifest.routes.entries()) {
      if (!route || typeof route !== "object") {
        throw new Error(`Extension manifest route at index ${index} is invalid`);
      }
      if (!route.path || typeof route.path !== "string") {
        throw new Error(
          `Extension manifest route at index ${index} is missing required 'path' field`,
        );
      }
      if (route.menuItem?.icon && typeof route.menuItem.icon === "string") {
        route.menuItem.icon = resolveMenuIcon(route.menuItem.icon, files);
        if (!route.menuItem.icon) {
          delete route.menuItem.icon;
        }
      }
    }
  }

  if (manifest.jobs !== undefined) {
    if (!Array.isArray(manifest.jobs)) {
      throw new Error("Extension manifest 'jobs' must be an array");
    }
    for (const job of manifest.jobs) {
      if (!job || typeof job !== "object") {
        throw new Error("Extension manifest contains invalid job definition");
      }
      if (!job.id || typeof job.id !== "string") {
        throw new Error("Extension manifest job is missing required 'id' field");
      }
      if (!job.entry || typeof job.entry !== "string") {
        throw new Error(
          `Extension manifest job '${job.id}' is missing required 'entry' field`,
        );
      }
      if (job.description !== undefined && typeof job.description !== "string") {
        throw new Error(
          `Extension manifest job '${job.id}' has a non-string 'description'`,
        );
      }
    }
  }

  if (manifest.integrations !== undefined) {
    validateIntegrations(manifest);
  }

  // Validate that declared entry files are present in the ZIP.
  for (const [key, entryPath] of Object.entries(manifest.entries)) {
    if (entryPath && !findZipEntry(files, entryPath)) {
      throw new Error(
        `Extension manifest entries.${key} references '${entryPath}' which is not in the package`,
      );
    }
  }

  // Routes require a view entry to render; a view entry without routes is never loaded.
  const hasRoutes = manifest.routes && manifest.routes.length > 0;
  const hasViewEntry = Boolean(manifest.entries.view);
  if (hasRoutes && !hasViewEntry) {
    throw new Error(
      "Extension manifest has routes but no entries.view — add a view entry or remove the routes",
    );
  }
  if (hasViewEntry && !hasRoutes) {
    throw new Error(
      "Extension manifest has entries.view but no routes — add routes or remove the view entry",
    );
  }

  return manifest;
}

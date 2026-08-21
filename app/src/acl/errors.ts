/** Base class for expected failures from ACL evaluation. */
export abstract class AclFailure extends Error {
  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** No identity was available for an operation that requires one. */
export class AuthenticationRequiredError extends AclFailure {
  constructor() {
    super("Authentication required");
  }
}

/** A credential was presented but could not be authenticated. */
export class CredentialRejectedError extends AclFailure {
  constructor(message = "Credential rejected") {
    super(message);
  }
}

/** A share exists but its password was absent or rejected. */
export class ShareLinkPasswordRequiredError extends CredentialRejectedError {
  readonly linkName: string | null;

  constructor(linkName: string | null) {
    super("Share link password required");
    this.linkName = linkName;
  }
}

/** The known identity does not hold the permission an operation requires. */
export class PermissionDeniedError extends AclFailure {
  readonly detail: string | undefined;

  constructor(detail?: string) {
    super(detail ?? "Permission denied");
    this.detail = detail;
  }
}

/** A resource is absent or deliberately unavailable to the caller. */
export class ResourceUnavailableError extends AclFailure {
  readonly resource: string;

  constructor(resource: string) {
    super(`${resource} unavailable`);
    this.resource = resource;
  }
}

/** ACL input violates a domain constraint. */
export class InvalidAclRequestError extends AclFailure {
  constructor(message: string) {
    super(message);
  }
}

/** Whether an unknown throw is an expected ACL refusal. */
export function isAccessDenied(error: unknown): error is AclFailure {
  return error instanceof AclFailure;
}

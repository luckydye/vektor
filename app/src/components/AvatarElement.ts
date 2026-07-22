import { api } from "#api/client.ts";
import eyesOne from "#assets/avatars/parts/eyes/eyes-1.svg?raw";
import eyesTwo from "#assets/avatars/parts/eyes/eyes-2.svg?raw";
import eyesThree from "#assets/avatars/parts/eyes/eyes-3.svg?raw";
import mouthOne from "#assets/avatars/parts/mouth/mouth-1.svg?raw";
import mouthTwo from "#assets/avatars/parts/mouth/mouth-2.svg?raw";
import mouthThree from "#assets/avatars/parts/mouth/mouth-3.svg?raw";
import avatarRobot from "#assets/avatars/robot.svg?raw";
import avatarZero from "#assets/avatars/zero.svg?raw";
import { isNoAuthMode, LOCAL_USER, LOCAL_USER_ID } from "#noAuth";
import { avatarColorFromHash, hashAvatarSeed } from "#utils/avatarColor.ts";

const avatarElementTag = "vektor-avatar";

interface AvatarUser {
  id?: string | null;
  email?: string | null;
  image?: string | null;
  name?: string | null;
}

const sizeMap = {
  small: 32,
  medium: 36,
  large: 48,
};

const eyesParts = [eyesOne, eyesTwo, eyesThree];
const mouthParts = [mouthOne, mouthTwo, mouthThree];
const defaultAvatar = `data:image/svg+xml,${encodeURIComponent(avatarZero)}`;
const robotAvatar = `data:image/svg+xml,${encodeURIComponent(avatarRobot)}`;

// Access tokens are represented in the ACL as "token:<token-id>" (see
// getTokenUserId). They are machines, not people, so they get a robot face
// instead of the hash-selected human features.
function isTokenSeed(seed: string): boolean {
  return seed.startsWith("token:");
}

const userCache = new Map<string, { expiresAt: number; user: AvatarUser }>();
const userRequests = new Map<string, Promise<AvatarUser | undefined>>();
const userCacheDuration = 5 * 60 * 1000;
const avatarStyles = `
  :host {
    display: block;
    flex: none;
  }

  .avatar {
    box-sizing: border-box;
    overflow: hidden;
    flex: none;
    border: 1px solid var(--color-neutral-800);
    border-radius: 9999px;
    background: var(--color-neutral-100);
  }

  .avatar-image {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
`;

function getAvatarSize(value: string | number | null): number {
  if (typeof value === "number") return value;
  if (value && value in sizeMap) return sizeMap[value as keyof typeof sizeMap];

  const parsedSize = Number(value);
  return Number.isFinite(parsedSize) && parsedSize > 0 ? parsedSize : sizeMap.medium;
}

// Each part SVG ships the shared face outline (a stroked circle) plus its own
// feature paths (filled). We drop the outline from every part, then overlay the
// hash-selected eyes and mouth on a single redrawn circle so the avatar is
// assembled from independently varying features.
const pathElementPattern = /<path\b[^>]*\/>/g;

function extractFeaturePaths(rawPart: string): string[] {
  return (rawPart.match(pathElementPattern) ?? []).filter(
    (path) => !path.includes("stroke="),
  );
}

function composeAvatar(eyes: string, mouth: string): string {
  const uniquePaths = [
    ...new Set([...extractFeaturePaths(eyes), ...extractFeaturePaths(mouth)]),
  ];

  return `<svg width="325" height="325" viewBox="0 0 325 325" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="162.5" cy="162.5" r="162" stroke="white"/>${uniquePaths.join("")}</svg>`;
}

function getGeneratedAvatar(seed: string): { color: string; src: string } {
  const hash = hashAvatarSeed(seed);
  const color = avatarColorFromHash(hash);

  if (isTokenSeed(seed)) {
    return { color, src: robotAvatar };
  }

  const eyes = eyesParts[hash % eyesParts.length];
  const mouth = mouthParts[(hash >>> 8) % mouthParts.length];

  return {
    color,
    src: `data:image/svg+xml,${encodeURIComponent(composeAvatar(eyes, mouth))}`,
  };
}

function hasAvatarIdentity(user: AvatarUser | null | undefined): boolean {
  return Boolean(user?.email || user?.image);
}

function resolveAvatarUser(
  providedUser: AvatarUser | null | undefined,
  fetchedUser: AvatarUser | undefined,
): AvatarUser | undefined {
  if (!providedUser) return fetchedUser;
  if (!fetchedUser) return providedUser;

  return {
    id: providedUser.id ?? fetchedUser.id,
    email: providedUser.email ?? fetchedUser.email,
    image: providedUser.image ?? fetchedUser.image,
    name: providedUser.name ?? fetchedUser.name,
  };
}

function loadUser(userId: string): Promise<AvatarUser | undefined> {
  if (isNoAuthMode() && userId === LOCAL_USER_ID) {
    return Promise.resolve(LOCAL_USER);
  }

  const cachedUser = userCache.get(userId);
  if (cachedUser && cachedUser.expiresAt > Date.now()) {
    return Promise.resolve(cachedUser.user);
  }

  const request = userRequests.get(userId);
  if (request) return request;

  const nextRequest = api.users
    .getById(userId)
    .then((user) => {
      userCache.set(userId, { expiresAt: Date.now() + userCacheDuration, user });
      return user;
    })
    .catch(() => undefined)
    .finally(() => {
      userRequests.delete(userId);
    });
  userRequests.set(userId, nextRequest);
  return nextRequest;
}

const AvatarElement =
  typeof HTMLElement === "undefined"
    ? undefined
    : class AvatarElement extends HTMLElement {
        static observedAttributes = ["size", "user-id"];

        private readonly avatarContainer: HTMLDivElement;
        private fetchedUser: AvatarUser | undefined;
        private loadVersion = 0;
        private providedUser: AvatarUser | null | undefined;
        private providedSize: string | number | null = null;

        constructor() {
          super();

          const shadowRoot = this.attachShadow({ mode: "open" });
          const styles = document.createElement("style");
          styles.textContent = avatarStyles;

          this.avatarContainer = document.createElement("div");
          shadowRoot.append(styles, this.avatarContainer);
        }

        get size(): string | number | null {
          return this.providedSize ?? this.getAttribute("size");
        }

        set size(value: string | number | null) {
          this.providedSize = value;
          this.render();
        }

        get user(): AvatarUser | null | undefined {
          return this.providedUser;
        }

        set user(value: AvatarUser | null | undefined) {
          this.loadVersion += 1;
          this.providedUser = value;
          this.fetchedUser = undefined;
          this.render();
          void this.resolveUser();
        }

        connectedCallback() {
          this.render();
          void this.resolveUser();
        }

        disconnectedCallback() {
          this.loadVersion += 1;
        }

        attributeChangedCallback(name: string) {
          if (name === "size") {
            this.providedSize = null;
            this.render();
            return;
          }

          this.fetchedUser = undefined;
          this.render();
          void this.resolveUser();
        }

        private async resolveUser() {
          if (!this.isConnected || hasAvatarIdentity(this.providedUser)) return;

          const userId = this.getAttribute("user-id");
          if (!userId || isTokenSeed(userId)) return;

          const version = ++this.loadVersion;
          const user = await loadUser(userId);
          if (!this.isConnected || version !== this.loadVersion) return;

          this.fetchedUser = user;
          this.render();
        }

        private render() {
          const user = resolveAvatarUser(this.providedUser, this.fetchedUser);
          const size = getAvatarSize(this.size);
          const avatar = document.createElement("div");

          avatar.className = "avatar";
          avatar.style.width = `${size}px`;
          avatar.style.height = `${size}px`;

          if (user?.image) {
            const image = document.createElement("img");
            image.src = user.image;
            image.alt = user.name || user.email || "User profile";
            image.className = "avatar-image";
            avatar.appendChild(image);
          } else {
            const image = document.createElement("img");
            // Generated avatars are seeded by the stable user id so the same
            // person renders identically everywhere, regardless of whether the
            // caller has their (PII-gated) email.
            const seed = (user?.id ?? this.getAttribute("user-id"))?.trim();
            if (seed) {
              const generatedAvatar = getGeneratedAvatar(seed);
              avatar.style.background = generatedAvatar.color;
              image.src = generatedAvatar.src;
            } else {
              image.src = defaultAvatar;
            }
            image.alt = user?.name || user?.email || "User profile";
            image.className = "avatar-image";
            avatar.appendChild(image);
          }

          this.avatarContainer.replaceChildren(avatar);
        }
      };

if (
  typeof customElements !== "undefined" &&
  AvatarElement &&
  !customElements.get(avatarElementTag)
) {
  customElements.define(avatarElementTag, AvatarElement);
}

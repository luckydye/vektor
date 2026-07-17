import { api } from "#api/client.ts";
import avatarOne from "#assets/avatars/one.svg?raw";
import avatarThree from "#assets/avatars/three.svg?raw";
import avatarTwo from "#assets/avatars/two.svg?raw";
import avatarZero from "#assets/avatars/zero.svg?raw";
import { isNoAuthMode, LOCAL_USER, LOCAL_USER_ID } from "#noAuth";

const avatarElementTag = "vektor-avatar";

interface AvatarUser {
  email?: string | null;
  image?: string | null;
  name?: string | null;
}

const sizeMap = {
  small: 32,
  medium: 36,
  large: 48,
};

const generatedAvatars = [avatarOne, avatarTwo, avatarThree];
const defaultAvatar = `data:image/svg+xml,${encodeURIComponent(avatarZero)}`;

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
    border: 1px solid var(--color-neutral-100, #f5f5f5);
    border-radius: 9999px;
    background: var(--color-neutral-200, #e5e5e5);
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

function hashEmail(email: string | null | undefined): number {
  const normalizedEmail = email?.trim().toLowerCase() ?? "";
  let hash = 0x811c9dc5;

  for (let index = 0; index < normalizedEmail.length; index += 1) {
    hash ^= normalizedEmail.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}

function getPrimaryColorHue(): number {
  const primaryColor = getComputedStyle(document.documentElement)
    .getPropertyValue("--color-primary")
    .trim();
  const hex = primaryColor.match(/^#([\da-f]{3}|[\da-f]{6})$/i)?.[1];
  if (!hex) return 283;

  const expandedHex = hex.length === 3 ? [...hex].map((value) => value.repeat(2)).join("") : hex;
  const red = Number.parseInt(expandedHex.slice(0, 2), 16) / 255;
  const green = Number.parseInt(expandedHex.slice(2, 4), 16) / 255;
  const blue = Number.parseInt(expandedHex.slice(4, 6), 16) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;

  if (delta === 0) return 283;
  if (max === red) return (60 * ((green - blue) / delta) + 360) % 360;
  if (max === green) return 60 * ((blue - red) / delta + 2);
  return 60 * ((red - green) / delta + 4);
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const hueSegment = hue / 60;
  const secondary = chroma * (1 - Math.abs((hueSegment % 2) - 1));
  const match = lightness - chroma / 2;

  let red = 0;
  let green = 0;
  let blue = 0;

  if (hueSegment < 1) [red, green] = [chroma, secondary];
  else if (hueSegment < 2) [red, green] = [secondary, chroma];
  else if (hueSegment < 3) [green, blue] = [chroma, secondary];
  else if (hueSegment < 4) [green, blue] = [secondary, chroma];
  else if (hueSegment < 5) [red, blue] = [secondary, chroma];
  else [red, blue] = [chroma, secondary];

  const componentToHex = (component: number) =>
    Math.round((component + match) * 255)
      .toString(16)
      .padStart(2, "0");

  return `#${componentToHex(red)}${componentToHex(green)}${componentToHex(blue)}`;
}

function getGeneratedAvatarColor(hash: number): string {
  const primaryColorHue = getPrimaryColorHue();
  const compoundOffsets = [30, 150, 210, 330];
  const hueVariation = ((hash >>> 24) % 17) - 8;
  const hue =
    (primaryColorHue + compoundOffsets[hash % compoundOffsets.length] + hueVariation) % 360;
  const saturation = 65 + ((hash >>> 8) % 26);
  const lightness = 74 + ((hash >>> 16) % 13);

  return hslToHex(hue, saturation / 100, lightness / 100);
}

function getGeneratedAvatar(email: string): { color: string; src: string } {
  const hash = hashEmail(email);

  return {
    color: getGeneratedAvatarColor(hash),
    src: `data:image/svg+xml,${encodeURIComponent(generatedAvatars[hash % generatedAvatars.length])}`,
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
          if (!userId) return;

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
            const email = user?.email?.trim();
            if (email) {
              const generatedAvatar = getGeneratedAvatar(email);
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

import { api } from "#api/client.ts";

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

  .avatar-initials {
    display: flex;
    width: 100%;
    height: 100%;
    align-items: center;
    justify-content: center;
    background: linear-gradient(
      to bottom right,
      var(--color-primary-500, #a25ebb),
      var(--color-purple-600, #9333ea)
    );
    color: white;
    font-family: inherit;
    font-size: var(--text-size-medium, 0.875rem);
    font-weight: 700;
    line-height: 2.2rem;
  }
`;

function getAvatarSize(value: string | number | null): number {
  if (typeof value === "number") return value;
  if (value && value in sizeMap) return sizeMap[value as keyof typeof sizeMap];

  const parsedSize = Number(value);
  return Number.isFinite(parsedSize) && parsedSize > 0 ? parsedSize : sizeMap.medium;
}

function getUserInitials(user: AvatarUser | undefined): string {
  const displayName = user?.name || user?.email;
  if (!displayName) return "?";

  const names = displayName.trim().split(/\s+/).filter(Boolean);
  if (names.length >= 2) {
    return `${names[0][0]}${names[names.length - 1][0]}`.toUpperCase();
  }
  return displayName[0]?.toUpperCase() || "?";
}

function loadUser(userId: string): Promise<AvatarUser | undefined> {
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
          if (!this.isConnected || this.providedUser) return;

          const userId = this.getAttribute("user-id");
          if (!userId) return;

          const version = ++this.loadVersion;
          const user = await loadUser(userId);
          if (!this.isConnected || version !== this.loadVersion) return;

          this.fetchedUser = user;
          this.render();
        }

        private render() {
          const user = this.providedUser || this.fetchedUser;
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
            const initials = document.createElement("div");
            initials.className = "avatar-initials";
            initials.textContent = getUserInitials(user);
            avatar.appendChild(initials);
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

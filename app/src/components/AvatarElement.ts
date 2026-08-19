import { api } from "#api/client.ts";
import eyesOne from "#assets/avatars/parts/eyes/eyes-1.svg?raw";
import eyesTwo from "#assets/avatars/parts/eyes/eyes-2.svg?raw";
import eyesThree from "#assets/avatars/parts/eyes/eyes-3.svg?raw";
import eyesFour from "#assets/avatars/parts/eyes/eyes-4.svg?raw";
import eyesFive from "#assets/avatars/parts/eyes/eyes-5.svg?raw";
import eyesSix from "#assets/avatars/parts/eyes/eyes-6.svg?raw";
import eyesSeven from "#assets/avatars/parts/eyes/eyes-7.svg?raw";
import eyesEight from "#assets/avatars/parts/eyes/eyes-8.svg?raw";
import mouthOne from "#assets/avatars/parts/mouth/mouth-1.svg?raw";
import mouthTwo from "#assets/avatars/parts/mouth/mouth-2.svg?raw";
import mouthThree from "#assets/avatars/parts/mouth/mouth-3.svg?raw";
import mouthFour from "#assets/avatars/parts/mouth/mouth-4.svg?raw";
import avatarRobot from "#assets/avatars/robot.svg?raw";
import avatarZero from "#assets/avatars/zero.svg?raw";
import { createCosmeticElement } from "#cosmetics/CosmeticElement.ts";
import type { PublicUserAppearance } from "#cosmetics/types.ts";
import { isNoAuthMode, LOCAL_USER, LOCAL_USER_ID } from "#noAuth";
import { avatarColorFromHash, hashAvatarSeed } from "#utils/avatarColor.ts";

const avatarElementTag = "vektor-avatar";

interface AvatarUser {
  id?: string | null;
  email?: string | null;
  image?: string | null;
  name?: string | null;
  appearance?: PublicUserAppearance;
}

const sizeMap = {
  small: 32,
  medium: 36,
  large: 48,
};

const eyesParts = [
  eyesOne,
  eyesTwo,
  eyesThree,
  eyesFour,
  eyesFive,
  eyesSix,
  eyesSeven,
  eyesEight,
];
const mouthParts = [mouthOne, mouthTwo, mouthThree, mouthFour];
const defaultAvatar = `data:image/svg+xml,${encodeURIComponent(avatarZero)}`;
const robotAvatar = `data:image/svg+xml,${encodeURIComponent(avatarRobot)}`;

const userCache = new Map<string, { expiresAt: number; user: AvatarUser | undefined }>();
const userRequests = new Map<string, Promise<AvatarUser | undefined>>();
const userCacheDuration = 5 * 60 * 1000;
const avatarStyles = `
  :host {
    display: block;
    flex: none;
  }

  .avatar-root {
    position: relative;
    display: block;
    flex: none;
    overflow: visible;
  }

  .avatar {
    box-sizing: border-box;
    overflow: hidden;
    flex: none;
    border-radius: 9999px;
    background: var(--color-neutral-100);
    /* Inset shadow instead of a border so the ring paints *over* the image
       edge rather than shrinking the content box. */
    box-shadow: inset 0 0 0 1px
      color-mix(in srgb, var(--color-neutral-800) 30%, transparent);
  }

  .avatar-image {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .avatar-frame {
    position: absolute;
    /* Frame art puts the inner edge of its ring at 25/32 of the art box's
       half-width, so the ring sits flush with the avatar at an overhang of
       -14% — proportional, because a fixed pixel inset only lines up at one
       size. The extra half percent overlaps the avatar edge by a fraction of
       a pixel, which hides the antialiasing hairline between the two circles. */
    inset: -13.5%;
  }
`;

function getAvatarSize(value: string | number | null): number {
  if (typeof value === "number") return value;
  if (value && value in sizeMap) return sizeMap[value as keyof typeof sizeMap];

  const parsedSize = Number(value);
  return Number.isFinite(parsedSize) && parsedSize > 0 ? parsedSize : sizeMap.medium;
}

const pathElementPattern = /<path\b[^>]*\/>/g;

function extractFeaturePaths(rawPart: string): string[] {
  return rawPart.match(pathElementPattern) ?? [];
}

function composeAvatar(eyes: string, mouth: string): string {
  const uniquePaths = [
    ...new Set([...extractFeaturePaths(eyes), ...extractFeaturePaths(mouth)]),
  ];

  return `<svg width="34" height="34" viewBox="0 0 34 34" fill="none" xmlns="http://www.w3.org/2000/svg">${uniquePaths.join("")}</svg>`;
}

function getGeneratedAvatar(
  seed: string,
  kind: "person" | "credential",
): { color: string; src: string } {
  const hash = hashAvatarSeed(seed);
  const color = avatarColorFromHash(hash);

  // Machines get a robot face rather than hash-selected human features, on the
  // say-so of the caller listing them — never inferred from the id.
  if (kind === "credential") {
    return { color, src: robotAvatar };
  }

  const eyes = eyesParts[hash % eyesParts.length];
  const mouth = mouthParts[(hash >>> 8) % mouthParts.length];

  return {
    color,
    src: `data:image/svg+xml,${encodeURIComponent(composeAvatar(eyes, mouth))}`,
  };
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
    image: providedUser.image || fetchedUser.image,
    name: providedUser.name ?? fetchedUser.name,
    appearance: providedUser.appearance ?? fetchedUser.appearance,
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
    // A miss is cached like a hit: plenty of ids in an activity list belong to
    // nobody — a credential that wrote a revision, an account since deleted —
    // and each would otherwise 404 once per row that mentions it.
    .catch(() => {
      userCache.set(userId, {
        expiresAt: Date.now() + userCacheDuration,
        user: undefined,
      });
      return undefined;
    })
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
        static observedAttributes = ["size", "user-id", "credential"];

        private readonly avatarContainer: HTMLDivElement;
        private fetchedUser: AvatarUser | undefined;
        /** Set once a lookup has come back with nobody behind the id. */
        private noSuchUser = false;
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
          this.noSuchUser = false;
          this.render();
          void this.resolveUser();
        }

        /** A machine's avatar, said so by whoever is listing it. */
        private get isCredential(): boolean {
          return this.hasAttribute("credential");
        }

        private async resolveUser() {
          if (!this.isConnected || this.providedUser?.image) return;

          // Session profiles contain the stored image only. Resolve any missing
          // image here so every avatar also gets a server-derived Gravatar URL.
          const userId = (this.providedUser?.id || this.getAttribute("user-id"))?.trim();
          // A credential has no user row, so there is no profile to resolve.
          if (!userId || this.isCredential) return;

          const version = ++this.loadVersion;
          const user = await loadUser(userId);
          if (!this.isConnected || version !== this.loadVersion) return;

          this.fetchedUser = user;
          this.noSuchUser = !user;
          this.render();
        }

        private render() {
          const user = resolveAvatarUser(this.providedUser, this.fetchedUser);
          const size = getAvatarSize(this.size);
          const root = document.createElement("div");
          const avatar = document.createElement("div");

          root.className = "avatar-root";
          root.style.width = `${size}px`;
          root.style.height = `${size}px`;
          avatar.className = "avatar";
          avatar.style.width = `${size}px`;
          avatar.style.height = `${size}px`;

          const image = document.createElement("img");
          image.alt = user?.name || user?.email || "User profile";
          image.className = "avatar-image";

          // Generated avatars are seeded by the stable user id so the same
          // person renders identically everywhere, regardless of whether the
          // caller has their (PII-gated) email.
          const seed = (user?.id ?? this.getAttribute("user-id"))?.trim();
          const drawGeneratedAvatar = () => {
            // An id nobody could resolve gets the neutral face rather than a
            // person's features: it may be a credential, or an account since
            // deleted, and inventing a face for either claims a person.
            if (!seed || (this.noSuchUser && !this.isCredential)) {
              image.src = defaultAvatar;
              return;
            }

            const generatedAvatar = getGeneratedAvatar(
              seed,
              this.isCredential ? "credential" : "person",
            );
            avatar.style.background = generatedAvatar.color;
            image.src = generatedAvatar.src;
          };

          if (user?.image) {
            // A remote picture can fail for reasons we can't see up front: a
            // Gravatar URL 404s for an address with no account (d=404), and a
            // provider URL can expire. Either way, draw the generated face.
            image.addEventListener("error", drawGeneratedAvatar, { once: true });
            image.src = user.image;
          } else {
            drawGeneratedAvatar();
          }

          avatar.appendChild(image);

          root.appendChild(avatar);
          const frame = createCosmeticElement(user?.appearance?.avatarFrame);
          if (frame) {
            frame.className = "avatar-frame";
            root.appendChild(frame);
          }

          this.avatarContainer.replaceChildren(root);
        }
      };

if (
  typeof customElements !== "undefined" &&
  AvatarElement &&
  !customElements.get(avatarElementTag)
) {
  customElements.define(avatarElementTag, AvatarElement);
}

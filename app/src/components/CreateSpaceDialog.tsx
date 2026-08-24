import { createEffect, createSignal, on, Show } from "solid-js";
import { isHexColor } from "#utils/color.ts";
import { imageFileAsDataUrl } from "#utils/image.ts";
import { slugify, spaceSlugRejection } from "#utils/slug.ts";
import { Dialog } from "./Dialog.tsx";
import { DialogFooter } from "./DialogFooter.tsx";
import { SpaceProfileCard } from "./SpaceProfileCard.tsx";

const DEFAULT_BRAND_COLOR = "#42516d";

interface Props {
  show?: boolean;
  onUpdateShow?: (value: boolean) => void;
  // Awaited: a rejection (a taken slug, most often) has to keep the dialog
  // open and land in `formError`, so the handler must report back here.
  onCreate?: (data: {
    name: string;
    slug: string;
    brandColor: string;
    logoSvg: string;
  }) => void | Promise<void>;
}

export function CreateSpaceDialog(props: Props) {
  const [name, setName] = createSignal("");
  const [slug, setSlug] = createSignal("");
  const [brandColor, setBrandColor] = createSignal(DEFAULT_BRAND_COLOR);
  const [logoSvg, setLogoSvg] = createSignal("");
  const [formError, setFormError] = createSignal("");
  const [pending, setPending] = createSignal(false);

  function reset() {
    setName("");
    setSlug("");
    setBrandColor(DEFAULT_BRAND_COLOR);
    setLogoSvg("");
    setFormError("");
  }

  function handleClose() {
    setFormError("");
    props.onUpdateShow?.(false);
  }

  async function handleLogoUpload(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;

    try {
      setLogoSvg(await imageFileAsDataUrl(file));
      setFormError("");
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Failed to read image file");
    }
  }

  async function handleSubmit(event: Event) {
    event.preventDefault();
    if (pending()) return;

    if (!name().trim()) return setFormError("Please enter a space name");
    if (!slug().trim()) return setFormError("Please enter a slug");
    // The endpoint's own rule set, so "docs" is refused with the reason here
    // rather than after a round trip.
    const slugRejection = spaceSlugRejection(slug());
    if (slugRejection) return setFormError(slugRejection);
    if (!isHexColor(brandColor())) {
      return setFormError("Please enter a valid hex color (e.g., #42516d)");
    }

    setFormError("");
    setPending(true);
    try {
      await props.onCreate?.({
        name: name().trim(),
        slug: slug().trim(),
        brandColor: brandColor(),
        logoSvg: logoSvg(),
      });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to create space");
      return;
    } finally {
      setPending(false);
    }
    reset();
    handleClose();
  }

  createEffect(
    on(
      () => props.show,
      (show) => {
        if (!show) reset();
      },
      { defer: true },
    ),
  );

  return (
    <Dialog
      show={props.show}
      title="New space"
      onUpdateShow={(value) => {
        if (!value) handleClose();
      }}
      footer={
        <DialogFooter
          form="create-space-form"
          confirmLabel="Create"
          pendingLabel="Creating…"
          pending={pending()}
          onCancel={handleClose}
        />
      }
    >
      <form id="create-space-form" onSubmit={handleSubmit} class="space-y-4">
        <SpaceProfileCard
          name={name()}
          slug={slug()}
          brandColor={brandColor()}
          logo={logoSvg()}
          onUpdateBrandColor={setBrandColor}
          onLogoUpload={handleLogoUpload}
          onRemoveLogo={() => setLogoSvg("")}
        />

        <div>
          <label
            for="space-name"
            class="mb-1 block font-medium text-neutral-900 text-size-small"
          >
            Space Name
          </label>
          <input
            id="space-name"
            type="text"
            required
            value={name()}
            class="focus-ring w-full rounded-md border border-neutral-100 px-3 py-2 text-size-medium"
            placeholder="My Space"
            onInput={(event) => {
              setName(event.currentTarget.value);
              setSlug(slugify(event.currentTarget.value));
            }}
          />
        </div>

        <div>
          <label
            for="space-slug"
            class="mb-1 block font-medium text-neutral-900 text-size-small"
          >
            Slug
          </label>
          <input
            id="space-slug"
            type="text"
            required
            pattern="[a-z0-9-]+"
            value={slug()}
            class="focus-ring w-full rounded-md border border-neutral-100 px-3 py-2 text-size-medium"
            placeholder="my-wiki"
            onInput={(event) => setSlug(event.currentTarget.value)}
          />
          <p class="mt-1 text-neutral text-size-small">
            Lowercase letters, numbers and single inner hyphens
          </p>
        </div>

        <Show when={formError()}>
          <div class="rounded-md border border-red-200 bg-red-50 p-3">
            <p class="text-red-600 text-size-small">{formError()}</p>
          </div>
        </Show>
      </form>
    </Dialog>
  );
}

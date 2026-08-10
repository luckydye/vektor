import { createEffect, createSignal, on, Show } from "solid-js";
import { slugify } from "#utils/utils.ts";
import { Dialog } from "./Dialog.tsx";
import { DialogFooter } from "./DialogFooter.tsx";
import { SpaceProfileCard } from "./SpaceProfileCard.tsx";

const DEFAULT_BRAND_COLOR = "#42516d";
const MAX_LOGO_BYTES = 300 * 1024;

interface Props {
  show?: boolean;
  onUpdateShow?: (value: boolean) => void;
  onCreate?: (data: {
    name: string;
    slug: string;
    brandColor: string;
    logoSvg: string;
  }) => void;
}

const isValidSlug = (slug: string) => /^[a-z0-9-]+$/.test(slug);
const isValidHexColor = (color: string) => /^#[0-9A-Fa-f]{6}$/.test(color);

export function CreateSpaceDialog(props: Props) {
  const [name, setName] = createSignal("");
  const [slug, setSlug] = createSignal("");
  const [brandColor, setBrandColor] = createSignal(DEFAULT_BRAND_COLOR);
  const [logoSvg, setLogoSvg] = createSignal("");
  const [formError, setFormError] = createSignal("");

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

    if (!["image/svg+xml", "image/png", "image/jpeg"].includes(file.type)) {
      setFormError("Only SVG, PNG, and JPG files are supported");
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setFormError("Logo file must be smaller than 300 KB");
      return;
    }

    try {
      if (file.type === "image/svg+xml") {
        const text = (await file.text())
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
          .replace(/on\w+="[^"]*"/g, "")
          .replace(/on\w+='[^']*'/g, "");
        setLogoSvg(text);
      } else {
        const reader = new FileReader();
        reader.onload = (loadEvent) => setLogoSvg(loadEvent.target?.result as string);
        reader.onerror = () => setFormError("Failed to read image file");
        reader.readAsDataURL(file);
      }
      setFormError("");
    } catch {
      setFormError("Failed to read image file");
    }
  }

  function handleSubmit(event: Event) {
    event.preventDefault();

    if (!name().trim()) return setFormError("Please enter a space name");
    if (!slug().trim()) return setFormError("Please enter a slug");
    if (!isValidSlug(slug())) {
      return setFormError(
        "Slug must contain only lowercase letters, numbers, and hyphens",
      );
    }
    if (!isValidHexColor(brandColor())) {
      return setFormError("Please enter a valid hex color (e.g., #42516d)");
    }

    setFormError("");
    props.onCreate?.({
      name: name().trim(),
      slug: slug().trim(),
      brandColor: brandColor(),
      logoSvg: logoSvg(),
    });
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
            Only lowercase letters, numbers, and hyphens
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

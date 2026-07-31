import { Button } from "#components/Button.tsx";
import { ContextMenu } from "#components/ContextMenu.tsx";
import { Dialog } from "#components/Dialog.tsx";
import { DialogFooter } from "#components/DialogFooter.tsx";
import { FormField } from "#components/FormField.tsx";
import { Icon } from "#components/Icon.tsx";
import { Input } from "#components/Input.tsx";
import { MenuLink } from "#components/MenuLink.tsx";
import { PagerCursor } from "#components/PagerCursor.tsx";
import { SelectItem } from "#components/SelectItem.tsx";
import { SelectMenu } from "#components/SelectMenu.tsx";
import { SwitchToggle } from "#components/SwitchToggle.tsx";

import { setRegistryFramework } from "./render.ts";

/**
 * Logical name to current implementation.
 *
 * Specs name what they are testing — `component("Button")` — and never import a
 * component path. The migration branch re-points these entries at the `.tsx`
 * versions and every spec keeps passing unchanged, which is the whole point of
 * the tier 1 suite: it is the before/after check, so it must not be rewritten
 * halfway through the comparison.
 *
 * Keep this to components a spec actually renders. An entry nobody uses is a
 * component nobody is checking.
 */
const components = {
  Button,
  ContextMenu,
  Dialog,
  DialogFooter,
  FormField,
  Icon,
  Input,
  MenuLink,
  PagerCursor,
  SelectItem,
  SelectMenu,
  SwitchToggle,
} as const;

// Solid as of Phase 3 (ticket 1350). Flipping this line back to the `.vue`
// imports above is the whole of the before/after comparison — the specs are
// not touched either way, which is what makes them a check rather than a
// description.
setRegistryFramework("solid");

export type ComponentName = keyof typeof components;

export function component(name: ComponentName): unknown {
  const found = components[name];
  if (!found) throw new Error(`No component registered as "${name}"`);
  return found;
}

/** Every registered name, for a spec that asserts the registry stays resolvable. */
export function registeredNames(): ComponentName[] {
  return Object.keys(components) as ComponentName[];
}

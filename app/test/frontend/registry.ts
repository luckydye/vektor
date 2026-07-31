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

/**
 * Logical name to current implementation.
 *
 * Specs name what they are testing — `component("Button")` — and never import a
 * component path. That indirection is what let the whole tier 1 suite carry
 * over from Vue to Solid unedited: only this table changed.
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

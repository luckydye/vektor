import Button from "#components/Button.vue";
import Dialog from "#components/Dialog.vue";
import DialogFooter from "#components/DialogFooter.vue";
import FormField from "#components/FormField.vue";
import Icon from "#components/Icon.vue";
import Input from "#components/Input.vue";
import MenuLink from "#components/MenuLink.vue";
import PagerCursor from "#components/PagerCursor.vue";
import SelectItem from "#components/SelectItem.vue";
import SelectMenu from "#components/SelectMenu.vue";
import SwitchToggle from "#components/SwitchToggle.vue";

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

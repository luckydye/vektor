// url=https://www.figma.com/design/c4xQJ4HS3Y2rpnziB7zd5W/Atrium-Design-System?node-id=1108-281&t=Z70Af6tzBnqxBU8W-4
// source=src/components/MenuLink.vue
// component=MenuLink
import figma from "figma";

const instance = figma.selectedInstance;

const text = instance.getString("Text");
const icon = instance.getString("Icon");
const isActive = instance.getBoolean("Active", {
  true: "true",
  false: "false",
});

// biome-ignore lint/style/noDefaultExport: Code Connect template files require default exports.
export default {
  example: figma.code`
<MenuLink
  href="#"
  text="${text}"
  icon="${icon}"
  is-active="${isActive}"
/>`,
  imports: ['import { MenuLink } from "~/src/components";'],
  id: "menu-link",
};

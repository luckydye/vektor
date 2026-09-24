import { expect, test } from "@playwright/test";

/**
 * Turning a list into a task list from the formatting toolbar.
 *
 * The happy-dom specs drive the commands against `contentExtensions()`, and the
 * bug this covers lived in the gap between that and the real page: the document
 * editor keeps an empty paragraph after the last block, and the toggle's join
 * threw on it. Nothing surfaced — no error dialog, no console noise in the
 * editor, just a button that did nothing to a selected list.
 *
 * So the selection here is a real drag and the click is a real click on the
 * bubble toolbar, which only exists once something is selected.
 */

const SPACE = process.env.VEKTOR_E2E_SPACE ?? "visual";

test("the toolbar turns a selected bullet list into a task list", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  const spaces = await (await request.get("/api/v1/spaces")).json();
  const spaceId = spaces.find((s: { slug: string }) => s.slug === SPACE).id;
  const created = await (
    await request.post(`/api/v1/spaces/${spaceId}/documents`, {
      data: {
        content:
          "<ul><li><p>alpha</p></li><li><p>beta</p></li><li><p>gamma</p></li></ul>",
        type: "document",
        properties: { title: "List Toggle Fixture" },
      },
    })
  ).json();

  // An unpublished document opens straight into edit mode.
  await page.goto(`/${SPACE}/doc/${created.document.slug}`);
  const items = page.locator(".ProseMirror li");
  await expect(items).toHaveCount(3, { timeout: 30_000 });

  const first = await items.first().boundingBox();
  const last = await items.last().boundingBox();
  if (!first || !last) throw new Error("no list geometry");
  await page.mouse.move(first.x + 4, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(last.x + last.width - 4, last.y + last.height / 2, { steps: 8 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toContain(
    "gamma",
  );

  const taskList = page.locator('button[title="Task List"]');
  await expect(taskList).toBeVisible({ timeout: 10_000 });
  await taskList.click();

  const taskItems = page.locator('.ProseMirror li[data-type="taskItem"]');
  await expect(taskItems).toHaveCount(3, { timeout: 5_000 });
  await expect(taskItems.locator("input[type=checkbox]")).toHaveCount(3);
  await expect(taskItems.first()).toContainText("alpha");
  await expect(taskItems.last()).toContainText("gamma");

  // Toggling again puts the same items back, rather than piling up lists.
  await taskList.click();
  await expect(page.locator('.ProseMirror li[data-type="taskItem"]')).toHaveCount(0);
  await expect(page.locator(".ProseMirror ul li")).toHaveCount(0);
  await expect(page.locator(".ProseMirror")).toContainText("alpha");

  expect(errors).toEqual([]);
});

import { queryByText } from "@testing-library/dom";
import { createComponent, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { type OverviewUser, UsersOverview } from "#components/UsersOverview.tsx";

/**
 * The register is the only page that prints an account the viewer shares no
 * space with, so what matters is that it prints one at all — and that an empty
 * table is only ever shown once the server has actually answered.
 */

const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

type Props = Record<string, unknown>;

function mount(props: Props) {
  const container = document.createElement("div");
  document.body.append(container);
  const unmount = render(
    () => createComponent(UsersOverview as (props: Props) => JSX.Element, props),
    container,
  );
  disposers.push(() => {
    unmount();
    container.remove();
  });
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function user(overrides: Partial<OverviewUser> = {}): OverviewUser {
  return {
    id: "u1",
    name: "Ada Lovelace",
    email: "ada@acme.test",
    groups: [],
    joined: "11 Feb 2026",
    ...overrides,
  };
}

describe("UsersOverview", () => {
  it("lists an account with its email, groups and join date", async () => {
    mount({ users: [user({ groups: ["vektor-admins"] })] });
    await settle();

    expect(queryByText(document.body, "Ada Lovelace")).toBeTruthy();
    expect(queryByText(document.body, "ada@acme.test")).toBeTruthy();
    expect(queryByText(document.body, "vektor-admins")).toBeTruthy();
    expect(queryByText(document.body, "11 Feb 2026")).toBeTruthy();
  });

  it("says the instance has no accounts only when it has answered", async () => {
    mount({ users: [], loading: true });
    await settle();
    expect(queryByText(document.body, "No accounts have signed in yet.")).toBeNull();

    mount({ users: [] });
    await settle();
    expect(queryByText(document.body, "No accounts have signed in yet.")).toBeTruthy();
  });

  // The register is one page of accounts, so a full page must not read as the
  // whole instance — the endpoint's `offset` is how the rest is reached.
  it("says so when it is showing one page of the register", async () => {
    const note = "Only the most recent accounts are listed.";

    mount({ users: [user()] });
    await settle();
    expect(queryByText(document.body, note)).toBeNull();

    mount({ users: [user()], capped: true });
    await settle();
    expect(queryByText(document.body, note)).toBeTruthy();
  });

  // The register comes back empty for a caller who may not see it, so a request
  // that failed outright has to say so — an empty table would otherwise read as
  // an instance with nobody in it.
  it("reports a failure instead of an empty register", async () => {
    mount({ users: [], error: "Failed to list users" });
    await settle();

    expect(queryByText(document.body, "Failed to list users")).toBeTruthy();
    expect(queryByText(document.body, "No accounts have signed in yet.")).toBeNull();
  });
});

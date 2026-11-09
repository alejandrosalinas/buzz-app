// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { AuthorSettings } from "./AuthorSettings";
import { DEFAULT_RULES, loadPolicy, POLICY_KEY } from "./authors";
import { GhUnavailable, GitHubError, type GitHubCli } from "./gh";

const fallback = () =>
  screen.getByRole("combobox", { name: "When no rule matches" });
const choose = async (
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) => {
  await user.click(fallback());
  await user.click(await screen.findByRole("option", { name }));
};

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("shows the default rules, and saves only rules that parse", async () => {
  const user = userEvent.setup();
  render(<AuthorSettings active={() => true} />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Comments from anyone no rule denies can wake your agents.",
  );
  expect(fallback()).toHaveTextContent("Wake the agent");
  const rules = screen.getByRole("textbox", { name: /Rules/ });
  expect(rules).toHaveValue(DEFAULT_RULES);
  const save = screen.getByRole("button", { name: "Save" });
  expect(save).toBeDisabled();
  await user.clear(rules);
  await user.type(rules, "deny author:@me prefix:🤖{Enter}allow author:/(/");
  await user.click(save);
  expect(rules).toBeInvalid();
  expect(rules).toHaveAccessibleDescription(
    expect.stringContaining("Line 2: Invalid regular expression"),
  );
  expect(loadPolicy().text).toBe(DEFAULT_RULES);
  // Editing checks the rules again, so restoring the saved ones clears it.
  await user.clear(rules);
  await user.type(rules, DEFAULT_RULES);
  expect(rules).toBeValid();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(save).toBeDisabled();
  await user.clear(rules);
  await user.type(
    rules,
    "deny author:@me prefix:🤖{Enter}allow org:block{Enter}  allow author:copilot-pull-request-reviewer[[bot]  ",
  );
  await choose(user, "Don’t wake it");
  await user.click(save);
  expect(loadPolicy().text).toBe(
    "deny author:@me prefix:🤖\nallow org:block\nallow author:copilot-pull-request-reviewer[bot]",
  );
  expect(loadPolicy().fallback).toBe("deny");
  expect(rules).toHaveValue(loadPolicy().text);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(save).toBeDisabled();
  await choose(user, "Wake the agent");
  expect(save).toBeEnabled();
  await user.click(save);
  expect(loadPolicy().fallback).toBe("allow");
  expect(screen.getByRole("status")).toBeInTheDocument();
});

it("shows saved rules that no longer parse, with why, until they are fixed", async () => {
  const user = userEvent.setup();
  const text = "allow author:/^(?!eve$)[a-z]+$/";
  localStorage.setItem(
    POLICY_KEY,
    JSON.stringify({ version: 2, text, fallback: "deny" }),
  );
  render(<AuthorSettings active={() => true} />);
  const rules = screen.getByRole("textbox", { name: /Rules/ });
  expect(rules).toHaveValue(text);
  expect(rules).toBeInvalid();
  expect(rules).toHaveAccessibleDescription(
    expect.stringContaining("Line 1: a pattern's groups can only be"),
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "no comment or review wakes your agents",
  );
  expect(fallback()).toHaveTextContent("Don’t wake it");
  await user.clear(rules);
  await user.type(rules, "deny author:eve{Enter}allow author:/^[[a-z]+$/");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(loadPolicy().error).toBeUndefined();
  expect(rules).toBeValid();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("names the account gh is signed in to, which author:@me means", async () => {
  const queries: string[] = [];
  const gh = (async (query: string) => {
    queries.push(query);
    return { viewer: { login: "octocat" } };
  }) as GitHubCli;
  render(<AuthorSettings active={() => true} gh={gh} />);
  expect(
    await screen.findByText("Signed in to GitHub as octocat through gh."),
  ).toBeInTheDocument();
  expect(queries).toEqual(["query{viewer{login}}"]);
});

it("says why gh cannot name the account", async () => {
  for (const [error, text] of [
    [
      new GhUnavailable("Processes require an installed desktop plugin"),
      "gh couldn’t read your GitHub account: Processes require an installed desktop plugin",
    ],
    [
      new GitHubError("Bad credentials"),
      "gh couldn’t read your GitHub account: Bad credentials",
    ],
  ] as const) {
    const gh = (async () => {
      throw error;
    }) as GitHubCli;
    render(<AuthorSettings active={() => true} gh={gh} />);
    expect(await screen.findByText(text)).toBeInTheDocument();
    cleanup();
  }
});

it("keeps the rule syntax behind a disclosure", async () => {
  const user = userEvent.setup();
  render(<AuthorSettings active={() => true} />);
  const syntax = screen.getByRole("button", { name: "Rule syntax" });
  expect(syntax).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByText(/author:@me is your GitHub account/)).toBeNull();
  await user.click(syntax);
  expect(screen.getByText(/author:@me is your GitHub account/)).toBeVisible();
});

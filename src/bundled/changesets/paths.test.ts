import { describe, expect, it } from "vitest";
import { workspaceCanvas } from "../../features/solo/workspace";
import { baseName, gitDirectory, projectFolders } from "./paths";

const canvas = (...folders: string[]) =>
  workspaceCanvas({ folders, canvas: "" });

describe("projectFolders", () => {
  it("keeps absolute and home folders in either platform's notation", () => {
    const folders = [
      "/Users/me/app",
      "~/app",
      "~",
      "~\\app",
      "C:\\Users\\me\\app",
      "d:/work/app",
      "\\\\server\\share\\app",
    ];
    expect(projectFolders(canvas(...folders))).toEqual(folders);
  });

  it("drops relative paths and any that climb out with ..", () => {
    expect(
      projectFolders(
        canvas(
          "app",
          "./app",
          "../app",
          "/Users/me/../you/app",
          "C:\\Users\\..\\you",
          "~\\..\\you",
          "/Users/me/ok",
        ),
      ),
    ).toEqual(["/Users/me/ok"]);
  });

  it("names none without a workspace", () => {
    expect(projectFolders(undefined)).toEqual([]);
    expect(projectFolders("# Notes")).toEqual([]);
  });
});

describe("gitDirectory", () => {
  it("turns home-relative folders into paths from the home git starts in", () => {
    expect(gitDirectory("~")).toBe(".");
    expect(gitDirectory("~/code/app")).toBe("code/app");
    expect(gitDirectory("~\\code\\app")).toBe("code\\app");
    expect(gitDirectory("/Users/me/app")).toBe("/Users/me/app");
    expect(gitDirectory("C:\\Users\\me\\app")).toBe("C:\\Users\\me\\app");
  });
});

describe("baseName", () => {
  it("splits on either separator", () => {
    expect(baseName("C:\\Users\\me\\app\\")).toBe("app");
    expect(baseName("/Users/me/app")).toBe("app");
    expect(baseName("C:/work/app")).toBe("app");
  });
});

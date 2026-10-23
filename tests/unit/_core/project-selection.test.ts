import { describe, expect, it } from "vitest";
import {
  projectPathFrom,
  selectProjects,
  UNKNOWN_PROJECT,
} from "../../../src/_core/utils/project-selection.js";

interface UsageRecord {
  project: string;
}

const projectOf = (record: UsageRecord): string => record.project;

const CLIENT_A = "/Users/dev/clientA-app";
const CLIENT_B = "/Users/dev/clientB-app";
const CLIENT_B_API = "/Users/dev/clientB-app/packages/api";
const SIDE_PROJECT = "/Users/dev/side-project";

const caseVariants: UsageRecord[] = [{ project: "/home/dev/Acme" }, { project: "/home/dev/acme" }];

const sharedFolderName: UsageRecord[] = [
  { project: "/Users/dev/clientA-app/apps/web" },
  { project: "/Users/dev/clientB-app/apps/web" },
];

const records: UsageRecord[] = [
  { project: CLIENT_A },
  { project: CLIENT_B },
  { project: CLIENT_A },
  { project: SIDE_PROJECT },
];

const select = (
  items: UsageRecord[],
  project?: string,
  excludeProject?: string,
): ReturnType<typeof selectProjects<UsageRecord>> =>
  selectProjects(items, projectOf, { project, excludeProject });

describe("selectProjects", () => {
  it("keeps every project when no selector is given", () => {
    const { included, breakdown } = select(records);

    expect(included).toHaveLength(4);
    expect(breakdown.map((entry) => entry.project)).toEqual([CLIENT_A, CLIENT_B, SIDE_PROJECT]);
    expect(breakdown.every((entry) => entry.included)).toBe(true);
  });

  it("withholds the records of every project the import was not limited to", () => {
    expect(select(records, "clientA-app").included.map(projectOf)).toEqual([CLIENT_A, CLIENT_A]);
  });

  it("withholds the records of an excluded project and keeps the rest", () => {
    const { included } = select(records, undefined, "clientB-app");

    expect(included.map(projectOf)).not.toContain(CLIENT_B);
    expect(included).toHaveLength(3);
  });

  it("lets an exclusion override an inclusion naming the same project", () => {
    const { included } = select(records, "clientA-app,clientB-app", "clientB-app");

    expect(included.map(projectOf)).toEqual([CLIENT_A, CLIENT_A]);
  });

  it("counts every project it found, including the ones it leaves out", () => {
    expect(select(records, "clientA-app").breakdown).toEqual([
      { project: CLIENT_A, records: 2, included: true },
      { project: CLIENT_B, records: 1, included: false },
      { project: SIDE_PROJECT, records: 1, included: false },
    ]);
  });

  it("matches a selector against the full path as well as the folder name", () => {
    expect(select(records, CLIENT_B).included.map(projectOf)).toEqual([CLIENT_B]);
  });

  it("matches a folder name whatever its case", () => {
    expect(select(records, "CLIENTA-APP").included).toHaveLength(2);
  });

  it("never matches a project on a fragment of its folder name", () => {
    expect(select(records, "clientA").included).toEqual([]);
  });

  it("withholds the subdirectories a project was worked from when it is excluded", () => {
    const withSubdirectory = [...records, { project: CLIENT_B_API }];

    const { included } = select(withSubdirectory, undefined, CLIENT_B);

    expect(included.map(projectOf)).not.toContain(CLIENT_B_API);
    expect(included).toHaveLength(3);
  });

  it("carries the subdirectories a project was worked from when it is the named project", () => {
    const withSubdirectory = [...records, { project: CLIENT_B_API }];

    const { included } = select(withSubdirectory, "clientB-app");

    expect(included.map(projectOf)).toEqual([CLIENT_B, CLIENT_B_API]);
  });

  it("reads a path the shell completed with a trailing slash as the same project", () => {
    const { included, unmatched } = select(records, undefined, `${CLIENT_B}/`);

    expect(included.map(projectOf)).not.toContain(CLIENT_B);
    expect(unmatched).toEqual([]);
  });

  it("withholds the records whose project could not be read once either option is given", () => {
    const withUnknown = [...records, { project: UNKNOWN_PROJECT }];

    expect(select(withUnknown, undefined, "clientB-app").included.map(projectOf)).not.toContain(
      UNKNOWN_PROJECT,
    );
    expect(select(withUnknown, "clientA-app").included.map(projectOf)).not.toContain(
      UNKNOWN_PROJECT,
    );
    expect(select(withUnknown).included.map(projectOf)).toContain(UNKNOWN_PROJECT);
  });

  it("names the selectors no project answered to, per option", () => {
    expect(select(records, "typo-app", "other-typo").unmatched).toEqual([
      { flag: "--project", selectors: ["typo-app"] },
      { flag: "--exclude-project", selectors: ["other-typo"] },
    ]);
  });

  it("stays silent when every selector found its project", () => {
    expect(select(records, "clientA-app", "clientB-app").unmatched).toEqual([]);
  });

  it("refuses an option whose value names no project at all", () => {
    expect(select(records, " , ").unmatched).toEqual([{ flag: "--project", selectors: [" , "] }]);
  });

  it("names the projects a selector could not tell apart, as they were listed", () => {
    expect(select(sharedFolderName, "web").ambiguous).toEqual([
      {
        selector: "web",
        projects: ["/Users/dev/clientA-app/apps/web", "/Users/dev/clientB-app/apps/web"],
      },
    ]);
  });

  it("refuses a folder name that two projects differing only in case both answer to", () => {
    expect(select(caseVariants, "Acme").ambiguous).toEqual([
      { selector: "Acme", projects: ["/home/dev/acme", "/home/dev/Acme"] },
    ]);
  });

  it("tells apart two projects differing only in case when the full path is given", () => {
    const { included, ambiguous } = select(caseVariants, "/home/dev/Acme");

    expect(ambiguous).toEqual([]);
    expect(included.map(projectOf)).toEqual(["/home/dev/Acme"]);
  });

  it("names a full path no project answered to rather than falling back on its case variant", () => {
    expect(select([{ project: "/home/dev/acme" }], "/home/dev/Acme").unmatched).toEqual([
      { flag: "--project", selectors: ["/home/dev/Acme"] },
    ]);
  });

  it("refuses a folder name that also names a directory the projects sit under", () => {
    const sharedAncestorName: UsageRecord[] = [
      { project: "/Users/acme/work/acme" },
      { project: "/Users/acme/clientB-app" },
    ];

    expect(select(sharedAncestorName, "acme").ambiguous).toEqual([
      { selector: "acme", projects: ["/Users/acme", "/Users/acme/work/acme"] },
    ]);
  });

  it("answers no selector with the placeholder standing in for an unreadable project", () => {
    expect(select([...records, { project: UNKNOWN_PROJECT }], UNKNOWN_PROJECT).unmatched).toEqual([
      { flag: "--project", selectors: [UNKNOWN_PROJECT] },
    ]);
  });

  it("carries the records of every project a selector could not tell apart, for the caller to refuse", () => {
    expect(select(sharedFolderName, "web").included).toEqual(sharedFolderName);
  });

  it("reads a project and its subdirectories as the one project a selector names", () => {
    expect(select([...records, { project: CLIENT_B_API }], "clientB-app").ambiguous).toEqual([]);
  });
});

describe("projectPathFrom", () => {
  it("keeps the working directory a session recorded", () => {
    expect(projectPathFrom(CLIENT_A)).toBe(CLIENT_A);
  });

  it("stands in for a working directory that is missing or not a path", () => {
    expect(projectPathFrom(undefined)).toBe(UNKNOWN_PROJECT);
    expect(projectPathFrom("")).toBe(UNKNOWN_PROJECT);
    expect(projectPathFrom(123)).toBe(UNKNOWN_PROJECT);
  });
});

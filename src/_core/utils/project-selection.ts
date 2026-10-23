export const UNKNOWN_PROJECT = "unknown";

export function projectPathFrom(cwd: unknown): string {
  return typeof cwd === "string" && cwd !== "" ? cwd : UNKNOWN_PROJECT;
}

const INCLUDE_FLAG = "--project";
const EXCLUDE_FLAG = "--exclude-project";

interface ProjectFilter {
  include: string[];
  exclude: string[];
}

export interface ProjectBreakdownEntry {
  project: string;
  records: number;
  included: boolean;
}

export interface UnmatchedSelectors {
  flag: string;
  selectors: string[];
}

export interface AmbiguousSelector {
  selector: string;
  projects: string[];
}

export interface ProjectSelectors {
  project?: string;
  excludeProject?: string;
}

export interface ProjectSelection<T> {
  included: T[];
  breakdown: ProjectBreakdownEntry[];
  unmatched: UnmatchedSelectors[];
  ambiguous: AmbiguousSelector[];
}

function parseSelectors(value?: string): string[] {
  return (value ?? "")
    .split(",")
    .map((selector) => selector.trim())
    .filter(Boolean);
}

function normalizeSeparators(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function selfAndAncestors(path: string): string[] {
  const segments = path.split("/");
  return segments
    .map((_, index) => segments.slice(0, segments.length - index).join("/"))
    .filter((ancestor) => ancestor.length > 0);
}

function matchedRoot(project: string, selector: string): string | null {
  const wanted = normalizeSeparators(selector);
  if (!wanted) return null;
  const candidates = selfAndAncestors(normalizeSeparators(project));
  if (wanted.includes("/")) return candidates.find((ancestor) => ancestor === wanted) ?? null;
  const name = wanted.toLowerCase();
  return candidates.find((ancestor) => lastSegment(ancestor).toLowerCase() === name) ?? null;
}

function matches(project: string, selector: string): boolean {
  return matchedRoot(project, selector) !== null;
}

function isIncluded(project: string, filter: ProjectFilter): boolean {
  const filtering = filter.include.length > 0 || filter.exclude.length > 0;
  if (project === UNKNOWN_PROJECT) return !filtering;
  if (filter.exclude.some((selector) => matches(project, selector))) return false;
  return (
    filter.include.length === 0 || filter.include.some((selector) => matches(project, selector))
  );
}

function unmatchedSelectorsFor(
  flag: string,
  value: string | undefined,
  projects: string[],
): UnmatchedSelectors | null {
  if (value === undefined) return null;
  const selectors = parseSelectors(value);
  if (selectors.length === 0) return { flag, selectors: [value] };
  const unmatched = selectors.filter(
    (selector) => !projects.some((project) => matches(project, selector)),
  );
  return unmatched.length > 0 ? { flag, selectors: unmatched } : null;
}

function ambiguousSelectorsFor(selectors: string[], projects: string[]): AmbiguousSelector[] {
  return selectors
    .map((selector) => ({
      selector,
      projects: [...new Set(projects.flatMap((project) => matchedRoot(project, selector) ?? []))],
    }))
    .filter((entry) => entry.projects.length > 1);
}

export function selectProjects<T>(
  items: T[],
  projectOf: (item: T) => string,
  selectors: ProjectSelectors,
): ProjectSelection<T> {
  const filter: ProjectFilter = {
    include: parseSelectors(selectors.project),
    exclude: parseSelectors(selectors.excludeProject),
  };
  const included: T[] = [];
  const entriesByProject = new Map<string, ProjectBreakdownEntry>();

  for (const item of items) {
    const project = projectOf(item);
    let entry = entriesByProject.get(project);
    if (!entry) {
      entry = { project, records: 0, included: isIncluded(project, filter) };
      entriesByProject.set(project, entry);
    }
    entry.records++;
    if (entry.included) included.push(item);
  }

  const breakdown = [...entriesByProject.values()].sort((a, b) =>
    a.project.localeCompare(b.project),
  );
  const projects = breakdown
    .map((entry) => entry.project)
    .filter((project) => project !== UNKNOWN_PROJECT);

  return {
    included,
    breakdown,
    unmatched: [
      unmatchedSelectorsFor(INCLUDE_FLAG, selectors.project, projects),
      unmatchedSelectorsFor(EXCLUDE_FLAG, selectors.excludeProject, projects),
    ].filter((entry): entry is UnmatchedSelectors => entry !== null),
    ambiguous: ambiguousSelectorsFor([...filter.include, ...filter.exclude], projects),
  };
}

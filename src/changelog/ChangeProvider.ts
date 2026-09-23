export type { PackageChangeProvider } from "../models/PackageChange";

let counter = 0;
/** Generates a stable-enough id for findings/changes within a single analysis run. */
export function nextChangeId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

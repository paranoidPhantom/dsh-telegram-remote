import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

// npm runs these tests at the project root. Never resolve package resources
// relative to compiled tests: that would inspect .build instead of the package.
export const projectRoot = pathToFileURL(`${resolve(process.cwd())}${sep}`);

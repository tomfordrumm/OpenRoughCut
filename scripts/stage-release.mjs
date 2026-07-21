import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const stagingRoot = path.join(projectRoot, ".release-stage");
const packageDocument = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));

await rm(stagingRoot, { recursive: true, force: true });
await mkdir(stagingRoot, { recursive: true });
for (const directory of ["dist", "electron", "src"]) {
  await cp(path.join(projectRoot, directory), path.join(stagingRoot, directory), { recursive: true });
}

const fromProjectParent = (resource) => ({
  ...resource,
  from: resource.from.startsWith("vendor/") ? `../${resource.from}` : resource.from,
});
const build = {
  ...packageDocument.build,
  electronVersion: packageDocument.devDependencies.electron,
  directories: {
    ...packageDocument.build.directories,
    output: "../release",
    buildResources: "../build",
  },
  mac: {
    ...packageDocument.build.mac,
    extraResources: packageDocument.build.mac.extraResources.map(fromProjectParent),
  },
  win: {
    ...packageDocument.build.win,
    extraResources: packageDocument.build.win.extraResources.map(fromProjectParent),
  },
  nsis: {
    ...packageDocument.build.nsis,
    include: "../build/installer.nsh",
  },
};
const stagedPackage = {
  name: packageDocument.name,
  version: packageDocument.version,
  description: packageDocument.description,
  author: packageDocument.author,
  private: true,
  type: packageDocument.type,
  main: packageDocument.main,
  build,
};

await writeFile(path.join(stagingRoot, "package.json"), `${JSON.stringify(stagedPackage, null, 2)}\n`, "utf8");
console.log(`Prepared release staging directory at ${stagingRoot}.`);

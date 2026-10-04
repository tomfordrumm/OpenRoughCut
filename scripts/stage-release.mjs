import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const stagingRoot = path.join(projectRoot, ".release-stage");
const targetPlatform = process.argv[2] ?? process.platform;
const packageDocument = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));

await rm(stagingRoot, { recursive: true, force: true });
await mkdir(stagingRoot, { recursive: true });
for (const directory of ["dist", "electron", "src"]) {
  await cp(path.join(projectRoot, directory), path.join(stagingRoot, directory), { recursive: true });
}
if (targetPlatform === "win32") {
  const prerequisiteDirectory = path.join(stagingRoot, "installer-prerequisites");
  await mkdir(prerequisiteDirectory, { recursive: true });
  await cp(
    path.join(projectRoot, "vendor", "win32-x64", "prerequisites", "vc_redist.x64.exe"),
    path.join(prerequisiteDirectory, "vc_redist.x64.exe"),
  );
}

const fromProjectParent = (resource) => ({
  ...resource,
  from: /^(vendor|build)\//.test(resource.from) ? `../${resource.from}` : resource.from,
});
const build = {
  ...packageDocument.build,
  extraResources: packageDocument.build.extraResources.map(fromProjectParent),
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

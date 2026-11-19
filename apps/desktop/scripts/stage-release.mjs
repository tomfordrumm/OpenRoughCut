import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// apps/desktop is staged together with a copy of packages/core, so the packaged
// app is self-contained: `#core/*` resolves to ./core/* inside the asar.
const desktopRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(desktopRoot, "..", "..");
const stagingRoot = path.join(desktopRoot, ".release-stage");
const targetPlatform = process.argv[2] ?? process.platform;
const packageDocument = JSON.parse(await readFile(path.join(desktopRoot, "package.json"), "utf8"));

await rm(stagingRoot, { recursive: true, force: true });
await mkdir(stagingRoot, { recursive: true });
await cp(path.join(repositoryRoot, "LICENSE"), path.join(stagingRoot, "LICENSE"));
for (const directory of ["dist", "electron", "src"]) {
  await cp(path.join(desktopRoot, directory), path.join(stagingRoot, directory), { recursive: true });
}
await cp(path.join(repositoryRoot, "packages", "core", "src"), path.join(stagingRoot, "core"), { recursive: true });
if (targetPlatform === "win32") {
  const prerequisiteDirectory = path.join(stagingRoot, "installer-prerequisites");
  await mkdir(prerequisiteDirectory, { recursive: true });
  await cp(
    path.join(repositoryRoot, "vendor", "win32-x64", "prerequisites", "vc_redist.x64.exe"),
    path.join(prerequisiteDirectory, "vc_redist.x64.exe"),
  );
}

// build/ belongs to the desktop app; vendor/ and the hoisted node_modules/ to the repository.
const fromStaging = (resource) => {
  const base = /^build\//.test(resource.from) ? desktopRoot : /^(vendor|node_modules)\//.test(resource.from) ? repositoryRoot : null;
  return base ? { ...resource, from: path.relative(stagingRoot, path.join(base, resource.from)) } : resource;
};
const build = {
  ...packageDocument.build,
  extraResources: packageDocument.build.extraResources.map(fromStaging),
  electronVersion: packageDocument.devDependencies.electron,
  directories: {
    ...packageDocument.build.directories,
    output: process.env.ORC_RELEASE_DIR ? path.resolve(process.env.ORC_RELEASE_DIR) : path.relative(stagingRoot, path.join(repositoryRoot, "release")),
    buildResources: path.relative(stagingRoot, path.join(desktopRoot, "build")),
  },
  mac: {
    ...packageDocument.build.mac,
    entitlements: path.join(desktopRoot, packageDocument.build.mac.entitlements),
    entitlementsInherit: path.join(desktopRoot, packageDocument.build.mac.entitlementsInherit),
    extraResources: packageDocument.build.mac.extraResources.map(fromStaging),
  },
  win: {
    ...packageDocument.build.win,
    extraResources: packageDocument.build.win.extraResources.map(fromStaging),
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
  imports: { "#core/*": "./core/*" },
  build,
};

await writeFile(path.join(stagingRoot, "package.json"), `${JSON.stringify(stagedPackage, null, 2)}\n`, "utf8");
console.log(`Prepared release staging directory at ${stagingRoot}.`);

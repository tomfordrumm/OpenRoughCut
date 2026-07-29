import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripClientRuntime } from "./static-html.mjs";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(projectDir, ".env");
const workDir = path.join(projectDir, "work");
const bundleDir = path.join(workDir, "yhub-site");
const archivePath = path.join(workDir, "openroughcut-yhub.zip");
const apiBase = "https://yhub.net/api/v1";

function parseEnv(source) {
  return Object.fromEntries(
    source
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

async function saveEnvValue(key, value) {
  const source = await readFile(envPath, "utf8");
  const lines = source.trimEnd().split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(`${key}=`));
  const entry = `${key}=${value}`;

  if (index === -1) lines.push(entry);
  else lines[index] = entry;

  await writeFile(envPath, `${lines.join("\n")}\n`);
}

async function request(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`Yhub request failed (${response.status}): ${JSON.stringify(payload)}`);
  }

  return payload;
}

async function renderStaticPage() {
  const workerUrl = pathToFileURL(path.join(projectDir, "dist/server/index.js"));
  workerUrl.searchParams.set("deploy", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(
    new Request("https://orc.yhub.net/", {
      headers: {
        accept: "text/html",
        host: "orc.yhub.net",
        "x-forwarded-host": "orc.yhub.net",
        "x-forwarded-proto": "https",
      },
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );

  if (!response.ok) throw new Error(`Static render failed (${response.status})`);

  await rm(bundleDir, { recursive: true, force: true });
  await mkdir(path.join(bundleDir, "assets"), { recursive: true });
  await cp(path.join(projectDir, "dist/client/assets"), path.join(bundleDir, "assets"), { recursive: true });
  await cp(path.join(projectDir, "dist/client/og.png"), path.join(bundleDir, "og.png"));
  const html = stripClientRuntime(await response.text());
  await writeFile(path.join(bundleDir, "index.html"), html);

  await rm(archivePath, { force: true });
  execFileSync("zip", ["-q", "-r", archivePath, "."], { cwd: bundleDir });
}

async function deploy() {
  const env = parseEnv(await readFile(envPath, "utf8"));
  if (!env.YHUB_TOKEN) throw new Error("YHUB_TOKEN is missing from website/.env");

  await renderStaticPage();

  const form = new FormData();
  form.append("bundle", new Blob([await readFile(archivePath)], { type: "application/zip" }), "openroughcut-yhub.zip");

  let payload;
  if (env.YHUB_SITE_ID) {
    payload = await request(`${apiBase}/sites/${env.YHUB_SITE_ID}/deployments/bundle`, env.YHUB_TOKEN, {
      method: "POST",
      body: form,
    });
  } else {
    form.append("domain", "orc");
    payload = await request(`${apiBase}/sites/bundles`, env.YHUB_TOKEN, {
      method: "POST",
      body: form,
    });
    await saveEnvValue("YHUB_SITE_ID", payload.data.id);
  }

  const siteId = payload.data.id;
  const deadline = Date.now() + 5 * 60 * 1000;
  let site = payload.data;

  while (Date.now() < deadline && !["active", "error"].includes(site.status?.label)) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    site = (await request(`${apiBase}/sites/${siteId}`, env.YHUB_TOKEN)).data;
  }

  if (site.status?.label === "error") throw new Error(`Yhub deployment failed: ${site.status.error}`);
  if (site.status?.label !== "active") throw new Error("Yhub deployment timed out before becoming active");

  console.log(JSON.stringify({ id: site.id, url: site.url, status: site.status.label }));
}

await deploy();

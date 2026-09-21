import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const IMAGE_TIMEOUT_MS = 120_000;

// Retry only Step 7 using Leomotors' own renderer and download flow. The
// unmodified upstream containers still use their original 30-second timeout.
export async function generateImage(page, { inputPath, serviceUrl, version, data }) {
  page.setDefaultTimeout(IMAGE_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(IMAGE_TIMEOUT_MS);
  page.on("pageerror", (error) => console.error(`[renderer exception] ${diagnosticText(error.message)}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      console.error(`[renderer console] ${diagnosticText(message.text())}`);
    }
  });
  page.on("requestfailed", (request) => {
    console.error(`[renderer request] ${diagnosticText(request.failure()?.errorText)} ${diagnosticText(request.url())}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      console.error(`[renderer HTTP ${response.status()}] ${diagnosticText(response.url())}`);
    }
  });

  const target = new URL(serviceUrl);
  if (data.scraperVersion) target.searchParams.set("scraperVersion", data.scraperVersion);
  console.log(`Retrying upstream image generation with ${IMAGE_TIMEOUT_MS / 1000}-second waits`);
  const response = await page.goto(target.toString(), { waitUntil: "domcontentloaded" });
  if (response && !response.ok()) throw new Error(`Renderer returned HTTP ${response.status()}`);

  await page.locator("#version").selectOption(version);
  await page.getByLabel("Upload JSON File").setInputFiles(inputPath);
  await page.getByText("Data fetched successfully,").waitFor({ state: "visible" });

  console.log("Rating data ready; waiting for the upstream PNG download");
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: IMAGE_TIMEOUT_MS }),
    page.getByRole("button", { name: "Generate and Download" }).click(),
  ]);
  const outputPath = inputPath.replace(/\.json$/i, ".png");
  await download.saveAs(outputPath);
  console.log(`Upstream rating image saved to ${outputPath}`);
}

// Never log request bodies, headers, data URLs, or URL credentials/query strings.
export function diagnosticText(value) {
  return String(value ?? "unknown error")
    .replace(/data:[^\s"'<>]+/g, "[data URL omitted]")
    .replace(/https?:\/\/[^\s"'<>]+/g, (value) => {
      try {
        const url = new URL(value);
        return `${url.origin}${url.pathname}`;
      } catch {
        return "[URL omitted]";
      }
    });
}

export async function findNewestInput(directory, game) {
  const candidates = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.startsWith("full-") || entry.name === "state.json") continue;

    const inputPath = path.join(directory, entry.name);
    let data;
    try {
      data = JSON.parse(await fs.readFile(inputPath, "utf8"));
    } catch {
      continue;
    }
    const profile = data?.profile;
    if (!profile || typeof profile !== "object" || !Array.isArray(data.best) || !Array.isArray(data.current)) continue;
    const detectedGame = "star" in profile ? "maimai" : "overpowerValue" in profile ? "chunithm" : undefined;
    if (detectedGame !== game) continue;

    const stat = await fs.stat(inputPath);
    candidates.push({ inputPath, data, mtimeMs: stat.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const input = candidates[0];
  if (!input) throw new Error(`No ${game} image-generation JSON was produced in ${directory}`);

  // A render retry must not turn an incomplete scrape into a successful import.
  const fullPath = path.join(directory, `full-${path.basename(input.inputPath)}`);
  const fullData = JSON.parse(await fs.readFile(fullPath, "utf8"));
  if (!Array.isArray(fullData.allRecords)) throw new Error(`Incomplete full export: ${fullPath}`);
  return input;
}

async function main() {
  const game = process.env.GAME?.trim().toLowerCase();
  const serviceUrl = process.env.SERVICE_URL?.trim();
  const version = process.env.VERSION?.trim();
  if (!["maimai", "chunithm"].includes(game)) throw new Error("GAME must be maimai or chunithm");
  if (!serviceUrl || !version) throw new Error("SERVICE_URL and VERSION are required");
  const input = await findNewestInput(process.env.OUTPUTS_DIR || "/app/outputs", game);

  // Playwright and Chromium are already installed in both upstream images.
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ timezoneId: "Asia/Bangkok" });
    await generateImage(page, { ...input, serviceUrl, version });
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Upstream image generation failed: ${diagnosticText(error.message)}`);
    process.exitCode = 1;
  });
}

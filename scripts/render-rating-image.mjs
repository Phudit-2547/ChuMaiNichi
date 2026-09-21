import fs from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

const SUPPORTED_GAMES = new Set(["maimai", "chunithm"]);
const game = process.env.GAME?.trim().toLowerCase();
const serviceUrl = process.env.SERVICE_URL?.trim();
const version = process.env.VERSION?.trim();
const outputsDir = process.env.OUTPUTS_DIR?.trim() || "/app/outputs";

if (!game || !SUPPORTED_GAMES.has(game)) {
  throw new Error("GAME must be either maimai or chunithm");
}
if (!version) {
  throw new Error("VERSION is required");
}

const dimensions =
  game === "maimai"
    ? { width: 2880, height: 1440 }
    : { width: 2560, height: 1440 };

const { filePath: inputPath, data } = await findNewestInput(outputsDir, game);
const outputPath = inputPath.replace(/\.json$/i, ".png");

const browser = await chromium.launch({
  headless: true,
  args: ["--disable-blink-features=AutomationControlled"],
});

try {
  const context = await browser.newContext({
    viewport: dimensions,
    timezoneId: process.env.TZ || "Asia/Bangkok",
  });

  let renderedRemotely = false;
  if (serviceUrl) {
    renderedRemotely = await renderFromService({
      context,
      inputPath,
      outputPath,
      serviceUrl,
      version,
    });
  }

  if (!renderedRemotely) {
    await renderLocalFallback({ context, data, outputPath });
  }
} finally {
  await browser.close();
}

console.log(`Rating image saved to ${outputPath}`);

async function findNewestInput(directory, expectedGame) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const candidates = [];

  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !entry.name.endsWith(".json") ||
      entry.name.startsWith("full-") ||
      entry.name === "state.json"
    ) {
      continue;
    }

    const filePath = path.join(directory, entry.name);
    try {
      const data = JSON.parse(await fs.readFile(filePath, "utf8"));
      if (detectGame(data) !== expectedGame) continue;
      const fileStat = await fs.stat(filePath);
      candidates.push({ filePath, data, mtimeMs: fileStat.mtimeMs });
    } catch (error) {
      console.warn(`Skipping unreadable JSON ${entry.name}: ${errorMessage(error)}`);
    }
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  if (candidates.length === 0) {
    throw new Error(
      `No ${expectedGame} image-generation JSON was produced in ${directory}`,
    );
  }

  return candidates[0];
}

function detectGame(data) {
  const profile = data?.profile ?? {};
  const firstChart = [...(data?.best ?? []), ...(data?.current ?? [])][0] ?? {};

  if ("star" in profile || "chartType" in firstChart || "dxScore" in firstChart) {
    return "maimai";
  }
  if (
    "overpowerValue" in profile ||
    "overpowerPercent" in profile ||
    "fullChain" in firstChart
  ) {
    return "chunithm";
  }
  return undefined;
}

async function renderFromService({
  context,
  inputPath,
  outputPath,
  serviceUrl,
  version,
}) {
  let lastError;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const page = await context.newPage();
    let lastHttpError = "";

    page.on("response", (response) => {
      if (response.status() >= 400) {
        lastHttpError = `${response.status()} ${response.url()}`;
      }
    });
    page.on("pageerror", (error) => {
      lastError = error;
    });
    page.setDefaultTimeout(20_000);
    page.setDefaultNavigationTimeout(30_000);

    try {
      const target = new URL(serviceUrl);
      target.searchParams.set("scraperVersion", String(data.scraperVersion ?? ""));

      const response = await page.goto(target.toString(), {
        waitUntil: "domcontentloaded",
      });
      if (response && !response.ok()) {
        throw new Error(`renderer returned HTTP ${response.status()}`);
      }

      await page.locator("#version").selectOption(version);
      await page.getByLabel("Upload JSON File").setInputFiles(inputPath);
      await page
        .getByText("Data fetched successfully,")
        .waitFor({ state: "visible", timeout: 30_000 });

      const chart = page.locator("#chart");
      await chart.waitFor({ state: "attached", timeout: 30_000 });
      await chart.evaluate((element) => {
        element.classList.remove("hidden");
        element.style.display = "flex";
      });
      await waitForRenderAssets(page, "#chart");
      await chart.screenshot({
        path: outputPath,
        type: "png",
        animations: "disabled",
      });

      console.log(`Rendered ${game} image through ${target.origin}`);
      await page.close();
      return true;
    } catch (error) {
      lastError = error;
      const httpContext = lastHttpError ? `; last HTTP error: ${lastHttpError}` : "";
      console.warn(
        `Remote renderer attempt ${attempt}/2 failed: ${errorMessage(error)}${httpContext}`,
      );
      await page.close();
      if (attempt < 2) await delay(2_000);
    }
  }

  console.warn(
    `Remote renderer unavailable; generating a self-contained fallback image: ${errorMessage(lastError)}`,
  );
  return false;
}

async function waitForRenderAssets(page, selector) {
  await page.evaluate(async (rootSelector) => {
    const root = document.querySelector(rootSelector);
    if (!root) throw new Error(`Missing render root: ${rootSelector}`);

    const waitForImage = (image) => {
      if (image.complete) return Promise.resolve();
      return new Promise((resolve) => {
        const done = () => resolve();
        image.addEventListener("load", done, { once: true });
        image.addEventListener("error", done, { once: true });
        setTimeout(done, 5_000);
      });
    };

    await Promise.all(Array.from(root.querySelectorAll("img"), waitForImage));
    await document.fonts.ready;
  }, selector);
  await page.waitForTimeout(500);
}

async function renderLocalFallback({ context, data, outputPath }) {
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);

  try {
    await page.setContent(buildFallbackDocument(data), { waitUntil: "load" });
    await waitForRenderAssets(page, "#fallback-card");
    await page.locator("#fallback-card").screenshot({
      path: outputPath,
      type: "png",
      animations: "disabled",
    });
    console.log(`Rendered ${game} image with the local fallback renderer`);
  } finally {
    await page.close();
  }
}

function buildFallbackDocument(data) {
  const profile = data?.profile ?? {};
  const bestLimit = game === "maimai" ? 35 : 30;
  const currentLimit = game === "maimai" ? 15 : 20;
  const bestColumns = game === "maimai" ? 7 : 6;
  const currentColumns = game === "maimai" ? 3 : 4;
  const rating = formatRating(profile.rating);
  const playerName = text(profile.playerName || "Unknown player");
  const honorText = text(profile.honorText || profile.mainHonorText || "");
  const lastPlayed = formatDate(profile.lastPlayed);
  const characterImage = safeImageSource(profile.characterImage);
  const title = game === "maimai" ? "maimai DX" : "CHUNITHM";
  const theme = game === "maimai" ? "#38bdf8" : "#f59e0b";
  const themeDark = game === "maimai" ? "#075985" : "#92400e";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
      body { font-family: "Noto Sans JP", "Noto Sans Thai", Inter, system-ui, sans-serif; }
      #fallback-card {
        width: ${dimensions.width}px;
        height: ${dimensions.height}px;
        padding: 38px;
        color: #f8fafc;
        background:
          radial-gradient(circle at 12% 8%, ${theme}55, transparent 28%),
          radial-gradient(circle at 90% 90%, ${themeDark}77, transparent 34%),
          linear-gradient(145deg, #0f172a 0%, #111827 52%, #020617 100%);
        display: flex;
        flex-direction: column;
        gap: 24px;
      }
      header {
        min-height: 205px;
        padding: 24px 30px;
        display: grid;
        grid-template-columns: 155px minmax(0, 1fr) auto;
        gap: 28px;
        align-items: center;
        background: #0f172acc;
        border: 2px solid ${theme}99;
        border-radius: 28px;
        box-shadow: 0 22px 60px #0008;
      }
      .avatar {
        width: 155px;
        height: 155px;
        border-radius: 24px;
        object-fit: cover;
        background: #1e293b;
        border: 4px solid ${theme};
      }
      .game { color: ${theme}; font-size: 34px; font-weight: 900; letter-spacing: .08em; }
      h1 { margin: 2px 0 8px; font-size: 58px; line-height: 1.05; }
      .meta { color: #cbd5e1; font-size: 25px; }
      .rating { text-align: right; padding: 0 20px; }
      .rating-label { color: #cbd5e1; font-size: 25px; text-transform: uppercase; letter-spacing: .12em; }
      .rating-value { color: ${theme}; font-size: 92px; line-height: 1; font-weight: 950; }
      .lists {
        flex: 1;
        min-height: 0;
        display: grid;
        grid-template-columns: ${bestColumns}fr ${currentColumns}fr;
        gap: 24px;
      }
      section {
        min-width: 0;
        padding: 22px;
        border-radius: 26px;
        background: #0f172ab8;
        border: 1px solid #94a3b844;
      }
      h2 { margin: 0 0 16px; font-size: 34px; }
      .tracks { display: grid; gap: 13px; align-content: start; }
      .best { grid-template-columns: repeat(${bestColumns}, minmax(0, 1fr)); }
      .current { grid-template-columns: repeat(${currentColumns}, minmax(0, 1fr)); }
      .track {
        height: 176px;
        min-width: 0;
        padding: 14px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        background: linear-gradient(145deg, #1e293bee, #0f172aee);
        border: 1px solid #64748b66;
        border-radius: 18px;
        box-shadow: 0 8px 18px #0005;
      }
      .track-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .index { color: #94a3b8; font-size: 22px; font-weight: 800; }
      .difficulty {
        padding: 5px 10px;
        border-radius: 999px;
        font-size: 18px;
        font-weight: 900;
        background: var(--difficulty-color, #475569);
      }
      .song {
        display: -webkit-box;
        overflow: hidden;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        font-size: 24px;
        line-height: 1.25;
        font-weight: 800;
      }
      .score { color: ${theme}; font-size: 29px; font-variant-numeric: tabular-nums; font-weight: 900; }
      footer { color: #94a3b8; text-align: right; font-size: 18px; }
    </style>
  </head>
  <body>
    <div id="fallback-card">
      <header>
        ${characterImage ? `<img class="avatar" src="${characterImage}" alt="" />` : `<div class="avatar"></div>`}
        <div>
          <div class="game">${title} · ${text(version)}</div>
          <h1>${playerName}</h1>
          <div class="meta">${honorText}${honorText && lastPlayed ? " · " : ""}${lastPlayed}</div>
        </div>
        <div class="rating">
          <div class="rating-label">Rating</div>
          <div class="rating-value">${rating}</div>
        </div>
      </header>
      <div class="lists">
        ${renderSection("BEST", data?.best, bestLimit, "best")}
        ${renderSection("CURRENT", data?.current, currentLimit, "current")}
      </div>
      <footer>Generated by ChuMaiNichi's local fallback renderer</footer>
    </div>
  </body>
</html>`;
}

function renderSection(label, charts, limit, className) {
  const rows = Array.isArray(charts) ? charts.slice(0, limit) : [];
  return `<section>
    <h2>${label} · ${rows.length}/${limit}</h2>
    <div class="tracks ${className}">
      ${rows.map((chart, index) => renderTrack(chart, index + 1)).join("")}
    </div>
  </section>`;
}

function renderTrack(chart, index) {
  const difficulty = String(chart?.difficulty ?? "unknown").toUpperCase();
  return `<article class="track">
    <div class="track-top">
      <span class="index">#${index}</span>
      <span class="difficulty" style="--difficulty-color:${difficultyColor(difficulty)}">${text(difficulty)}</span>
    </div>
    <div class="song">${text(chart?.title ?? "Unknown chart")}</div>
    <div class="score">${formatScore(chart?.score)}</div>
  </article>`;
}

function difficultyColor(difficulty) {
  return (
    {
      BASIC: "#16a34a",
      ADVANCED: "#ea580c",
      EXPERT: "#dc2626",
      MASTER: "#9333ea",
      "RE:MASTER": "#db2777",
      REMASTER: "#db2777",
      ULTIMA: "#111827",
      "WORLD'S END": "#334155",
    }[difficulty] ?? "#475569"
  );
}

function formatScore(value) {
  const score = Number(value);
  return Number.isFinite(score) ? Math.trunc(score).toLocaleString("en-US") : "—";
}

function formatRating(value) {
  const rating = Number(value);
  if (!Number.isFinite(rating)) return "—";
  return game === "maimai" ? String(Math.trunc(rating)) : rating.toFixed(2);
}

function formatDate(value) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return text(value);
  return text(
    new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: process.env.TZ || "Asia/Bangkok",
    }).format(parsed),
  );
}

function safeImageSource(value) {
  if (typeof value !== "string") return "";
  if (!value.startsWith("data:image/")) return "";
  return text(value);
}

function text(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

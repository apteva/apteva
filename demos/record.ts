/**
 * Apteva Demo Video Recorder
 *
 * Usage:
 *   bun demos/record.ts [scenario] [options]
 *
 * Options:
 *   --base-url    Base URL of apteva instance (default: http://localhost:4280)
 *   --username    Login username (default: admin)
 *   --password    Login password (default: admin)
 *   --output      Output directory (default: demos/output)
 *   --width       Video width (default: 1440)
 *   --height      Video height (default: 900)
 *   --slow        Slow motion multiplier in ms (default: 80)
 *
 * Examples:
 *   bun demos/record.ts overview
 *   bun demos/record.ts overview --base-url http://159.69.221.243:4280
 */

import { chromium, type Page, type BrowserContext } from "playwright";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { existsSync, mkdirSync, readdirSync } from "fs";

// ============ Config ============

const args = process.argv.slice(2);
const scenarioName = args.find(a => !a.startsWith("--")) || "overview";

function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  // Strip shell escape backslashes (e.g. \! → !)
  return idx !== -1 && args[idx + 1] ? args[idx + 1].replace(/\\([^\\])/g, "$1") : fallback;
}

const BASE_URL = getArg("base-url", "http://localhost:4280");
const USERNAME = getArg("username", "admin");
const PASSWORD = getArg("password", "admin");
const OUTPUT_DIR = getArg("output", join(dirname(import.meta.path), "output"));
const WIDTH = parseInt(getArg("width", "1440"));
const HEIGHT = parseInt(getArg("height", "900"));
const SLOW_MO = parseInt(getArg("slow", "80"));

// ============ Helpers ============

async function wait(ms: number) {
  await new Promise(r => setTimeout(r, ms));
}

async function typeSlowly(page: Page, selector: string, text: string, delay = 40) {
  await page.click(selector);
  await page.type(selector, text, { delay });
}

async function login(page: Page) {
  // Login via API first, then inject the token into the app
  console.log("  Authenticating via API...");
  const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  const loginData = await loginRes.json() as any;

  if (!loginData.accessToken) {
    console.error(`  Login failed: ${loginData.error || "unknown error"}`);
    // Fall back to form login
    await page.goto(`${BASE_URL}`);
    await wait(1000);
    const usernameInput = await page.$('#username');
    const passwordInput = await page.$('#password');
    if (usernameInput && passwordInput) {
      await usernameInput.click();
      await page.keyboard.type(USERNAME, { delay: 30 });
      await passwordInput.click();
      await page.keyboard.type(PASSWORD, { delay: 30 });
      await page.keyboard.press("Enter");
      await wait(3000);
    }
    return;
  }

  // Set a cookie with the refresh token and inject access token via route interception
  const cookies = loginRes.headers.get("set-cookie");
  if (cookies) {
    const match = cookies.match(/refresh_token=([^;]+)/);
    if (match) {
      const url = new URL(BASE_URL);
      await page.context().addCookies([{
        name: "refresh_token",
        value: match[1],
        domain: url.hostname,
        path: "/",
      }]);
    }
  }

  // Intercept auth check to inject the token into React state
  await page.route("**/api/auth/refresh", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accessToken: loginData.accessToken,
        expiresIn: 900,
        user: loginData.user,
      }),
    });
  });

  await page.goto(`${BASE_URL}`);
  await wait(2000);

  // Wait for app to load
  await page.waitForSelector('nav, [class*="sidebar"], [class*="dashboard"]', { timeout: 10000 }).catch(() => {});
  await wait(1000);
}

// ============ Scenarios ============

type Scenario = {
  name: string;
  description: string;
  run: (page: Page, context: BrowserContext) => Promise<void>;
};

const scenarios: Record<string, Scenario> = {
  overview: {
    name: "App Overview",
    description: "Quick tour of the Apteva dashboard, agents list, and key features",
    async run(page: Page) {
      // Login and land on dashboard
      await login(page);
      console.log("  Dashboard loaded");
      await wait(2000);

      // Scroll dashboard slowly to show stats
      await page.mouse.move(WIDTH / 2, HEIGHT / 2);
      await wait(1000);

      // Click on agents in sidebar
      const agentsLink = await page.$('a[href*="agents"], button:has-text("Agents"), [data-tab="agents"]');
      if (agentsLink) {
        console.log("  Navigating to agents...");
        await agentsLink.click();
        await wait(2000);
      }

      // Scroll through agents list
      await page.mouse.wheel(0, 300);
      await wait(1500);
      await page.mouse.wheel(0, 300);
      await wait(1500);

      // Click on first running agent
      const agentCard = await page.$('[class*="agent"]:has([class*="running"]), [class*="card"]');
      if (agentCard) {
        console.log("  Opening agent panel...");
        await agentCard.click();
        await wait(2000);

        // Show different tabs if available
        const tabs = await page.$$('[role="tab"], button[class*="tab"]');
        for (const tab of tabs.slice(0, 4)) {
          const tabText = await tab.textContent();
          console.log(`  Clicking tab: ${tabText?.trim()}`);
          await tab.click();
          await wait(1500);
        }
      }

      await wait(2000);
      console.log("  Overview complete");
    },
  },

  "create-agent": {
    name: "Create Agent",
    description: "Shows how to create, configure, and start a new AI agent with features",
    async run(page: Page) {
      await login(page);
      await wait(1500);

      // Brief look at dashboard
      console.log("  Dashboard loaded, heading to agents...");
      await wait(1500);

      // Navigate to agents via sidebar
      await page.click('button:has-text("Agents")');
      await wait(2000);

      // Show the agents list briefly
      console.log("  Viewing agents list...");
      await wait(1500);

      // Click "+ New Agent" button
      console.log("  Opening create agent modal...");
      await page.click('button:has-text("New Agent")');
      await page.waitForSelector('text="Create New Agent"', { timeout: 5000 });
      await wait(1200);

      // The form opens with defaults: Anthropic provider, Claude Sonnet model,
      // default system prompt, Memory + Vision enabled.

      // Clear and type agent name slowly
      console.log("  Typing agent name...");
      await page.click('input[placeholder="My Agent"]');
      await page.keyboard.type("Research Assistant", { delay: 65 });
      await wait(1000);

      // Provider is already set to Anthropic (default), model to Claude Sonnet 4.6
      // Show model selection by opening dropdown and picking a different model
      console.log("  Opening model selector...");
      await page.getByRole("button", { name: /Claude Sonnet 4\.6/ }).click();
      await wait(1200);
      // Browse the options, then pick Sonnet 4.5
      const sonnet45 = page.locator('.absolute.z-50 button:has-text("Sonnet 4.5")').first();
      if (await sonnet45.isVisible().catch(() => false)) {
        console.log("    Selecting Claude Sonnet 4.5...");
        await sonnet45.click();
      } else {
        // Close dropdown by pressing Escape
        await page.keyboard.press("Escape");
      }
      await wait(1000);

      // Clear the default system prompt and type a custom one
      console.log("  Writing system prompt...");
      const textarea = page.locator('textarea');
      await textarea.click();
      await textarea.fill("");
      await wait(300);
      await page.keyboard.type(
        "You are a research assistant that helps users find, analyze, and summarize information from the web. Provide well-structured responses with key findings highlighted.",
        { delay: 18 }
      );
      await wait(1500);

      // Scroll down inside the modal to show features
      console.log("  Scrolling to features...");
      await page.mouse.move(WIDTH / 2, HEIGHT / 2);
      await page.mouse.wheel(0, 350);
      await wait(1200);

      // Enable additional features (Memory + Vision already on by default)
      // Use description text to target feature buttons inside the modal (not sidebar)
      console.log("  Enabling additional features...");
      const featureDescs: Record<string, string> = {
        Tasks: "Schedule and execute tasks",
        Files: "File storage and management",
        MCP: "External tools/services",
      };
      for (const [name, desc] of Object.entries(featureDescs)) {
        const btn = page.locator(`button:has-text("${desc}")`).first();
        if (await btn.isVisible().catch(() => false)) {
          console.log(`    Toggling ${name}...`);
          await btn.click();
          await wait(700);
        }
      }
      await wait(800);

      // Scroll down more to show built-in tools
      await page.mouse.wheel(0, 250);
      await wait(1000);

      // Enable Web Search + Web Fetch tools (unique text, no ambiguity)
      for (const tool of ["Web Search", "Web Fetch"]) {
        const btn = page.locator(`button:has-text("${tool}")`).first();
        if (await btn.isVisible().catch(() => false)) {
          console.log(`  Enabling ${tool}...`);
          await btn.click();
          await wait(700);
        }
      }
      await wait(1200);

      // Scroll back up to show full form, then create
      await page.mouse.wheel(0, -500);
      await wait(1000);

      // Click Create
      console.log("  Creating agent...");
      // Find the exact "Create" button (not "Create New Agent" title)
      const allButtons = await page.$$('button');
      for (const btn of allButtons) {
        const text = await btn.textContent();
        if (text?.trim() === "Create") {
          await btn.click();
          break;
        }
      }
      await wait(3000);

      // Agent should appear in the list
      console.log("  Agent created!");
      await wait(2000);

      // Scroll through the agents list to show the new agent
      await page.mouse.move(WIDTH / 2, HEIGHT / 2);
      await page.mouse.wheel(0, 300);
      await wait(2000);

      await wait(1500);
      console.log("  Create agent scenario complete");
    },
  },
};

// ============ Runner ============

async function run() {
  const scenario = scenarios[scenarioName];
  if (!scenario) {
    console.error(`Unknown scenario: "${scenarioName}"`);
    console.log(`Available scenarios: ${Object.keys(scenarios).join(", ")}`);
    process.exit(1);
  }

  console.log(`\nRecording: ${scenario.name}`);
  console.log(`  Description: ${scenario.description}`);
  console.log(`  URL: ${BASE_URL}`);
  console.log(`  Resolution: ${WIDTH}x${HEIGHT}`);
  console.log(`  Output: ${OUTPUT_DIR}\n`);

  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  });

  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    recordVideo: {
      dir: OUTPUT_DIR,
      size: { width: WIDTH, height: HEIGHT },
    },
    colorScheme: "dark",
  });

  // Slow down interactions for visual clarity
  const page = await context.newPage();

  try {
    console.log("  Starting scenario...\n");
    await scenario.run(page, context);
    console.log("\n  Scenario finished, saving video...");
  } catch (err) {
    console.error(`\n  Scenario error: ${err}`);
  }

  // Close to flush video
  await page.close();
  await context.close();
  await browser.close();

  // Find the recorded video (Playwright saves as a random filename)
  const files = readdirSync(OUTPUT_DIR)
    .filter(f => f.endsWith(".webm"))
    .map(f => ({ name: f, path: join(OUTPUT_DIR, f), mtime: Bun.file(join(OUTPUT_DIR, f)).lastModified }))
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length === 0) {
    console.error("  No video file found!");
    process.exit(1);
  }

  const webmPath = files[0].path;
  const mp4Path = join(OUTPUT_DIR, `${scenarioName}-${new Date().toISOString().slice(0, 10)}.mp4`);

  // Convert webm to mp4 with ffmpeg
  console.log(`  Converting to MP4...`);
  try {
    execSync(`ffmpeg -y -i "${webmPath}" -c:v libx264 -preset fast -crf 22 -movflags +faststart "${mp4Path}" 2>/dev/null`);
    // Clean up webm
    execSync(`rm "${webmPath}"`);
    console.log(`\n  Video saved: ${mp4Path}`);
  } catch {
    console.log(`\n  WebM saved (ffmpeg conversion failed): ${webmPath}`);
  }
}

run().catch(console.error);

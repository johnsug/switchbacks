import { mergeAndWriteConfig } from "./config-writer.js";
import { ssoLogin } from "../sources/garmin.js";

export async function testAndSaveGarminPassword(
  email: string,
  password: string
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    await ssoLogin(email, password); // throws on bad credentials
    mergeAndWriteConfig({
      dataSource:      "garmin",
      garminAuthType:  "password",
      garminEmail:     email,
      garminPassword:  password,
      garminCookies:   null,
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err).replace(/^Error:\s*/i, "") };
  }
}

export async function garminSSOWithPlaywright(
  provider: "google" | "apple"
): Promise<{ success: true } | { success: false; error: string }> {
  // Dynamic import — playwright is optional at runtime
  let playwrightChromium: typeof import("playwright").chromium;
  try {
    playwrightChromium = (await import("playwright")).chromium;
  } catch {
    return {
      success: false,
      error: "Playwright is not installed. Run: npx playwright install chromium",
    };
  }

  let browser: Awaited<ReturnType<typeof playwrightChromium.launch>> | null = null;

  try {
    browser = await playwrightChromium.launch({ headless: false });
    const context = await browser.newContext();
    const page    = await context.newPage();

    await page.goto("https://connect.garmin.com/signin/", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    // Garmin's sign-in page uses an iframe for the SSO widget
    const frame = page.frameLocator("iframe").first();
    const btn = provider === "google"
      ? frame.locator('[class*="google" i], [data-testid*="google" i], [aria-label*="Google" i]').first()
      : frame.locator('[class*="apple" i],  [data-testid*="apple" i],  [aria-label*="Apple" i]').first();

    // Some Garmin pages load the buttons without an iframe
    const topBtn = provider === "google"
      ? page.locator('[class*="google" i], [data-testid*="google" i], [aria-label*="Google" i]').first()
      : page.locator('[class*="apple" i],  [data-testid*="apple" i],  [aria-label*="Apple" i]').first();

    // Click whichever resolves first
    await Promise.race([
      btn.click({ timeout: 15_000 }),
      topBtn.click({ timeout: 15_000 }),
    ]).catch(() => {
      // Neither found in time — user may be on an unexpected page
      throw new Error(`Could not find the ${provider} sign-in button. Try using email/password instead.`);
    });

    // Wait for the user to complete authentication (up to 2 minutes).
    // Google/Apple may open in a popup — we watch both pages for the final redirect.
    await context.waitForEvent("page").catch(() => null); // tolerate no popup

    await page.waitForURL(
      (url) => url.hostname.includes("connect.garmin.com") && !url.pathname.includes("signin"),
      { timeout: 120_000 }
    );

    const rawCookies = await context.cookies([
      "https://connect.garmin.com",
      "https://sso.garmin.com",
    ]);

    const cookies: Record<string, string> = {};
    for (const c of rawCookies) cookies[c.name] = c.value;

    mergeAndWriteConfig({
      dataSource:             "garmin",
      garminAuthType:         "sso",
      garminEmail:            null,
      garminPassword:         null,
      garminCookies:          cookies,
      garminCookiesObtainedAt: Date.now(),
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err).replace(/^Error:\s*/i, "") };
  } finally {
    await browser?.close().catch(() => null);
  }
}

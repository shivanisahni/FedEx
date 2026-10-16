import { chromium } from 'playwright';

/**
 * Opens the portal and returns the details to text.
 * Everything portal-specific lives here: fill in the TODOs once you know the page.
 * Returns an array of lines (strings) that get joined into the SMS body.
 */
export async function scrapePortal() {
  const url = process.env.PORTAL_URL;
  if (!url) throw new Error('PORTAL_URL is not set');

  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // Login: portal landing page -> "Sign In" -> PurpleID (Okta): username -> Next -> password.
    const { PORTAL_USER, PORTAL_PASS } = process.env;
    if (!PORTAL_USER || !PORTAL_PASS) throw new Error('PORTAL_USER / PORTAL_PASS are not set');

    await page.locator('input[type=submit][value="Sign In"]').click();

    await page.locator('input[name=identifier]').fill(PORTAL_USER);
    await page.getByRole('button', { name: /next|continue/i }).click();

    await page.locator('input[type=password]').fill(PORTAL_PASS);
    await page.getByRole('button', { name: /sign in|log in|verify|next/i }).click();

    // Wait until we're back on the portal (off the Okta domain).
    await page.waitForURL(/mybizaccount\.fedex\.com/, { timeout: 60_000 });
    await page.waitForLoadState('networkidle');

    // TODO: replace with the real selectors/data. Placeholder just grabs the page title.
    const heading = (await page.title()).trim();

    return [`Portal check: ${heading}`, url];
  } catch (err) {
    // Save a screenshot so the workflow can upload it for debugging.
    await page.screenshot({ path: 'artifacts/failure.png', fullPage: true }).catch(() => {});
    throw err;
  } finally {
    await browser.close();
  }
}

import { chromium } from 'playwright';

const DEBUG = !!process.env.DEBUG_DUMP;
let step = 0;

/** In debug mode, save a screenshot + HTML of the current page so we can find selectors. */
async function snap(page, name) {
  if (!DEBUG) return;
  const base = `artifacts/${String(++step).padStart(2, '0')}-${name}`;
  const { writeFile } = await import('node:fs/promises');
  // Viewport shot only: the FCC app makes full-page screenshots 1px wide.
  await page.screenshot({ path: `${base}.png` }).catch(() => {});
  await writeFile(`${base}.html`, await page.content()).catch(() => {});
  await writeFile(`${base}.txt`, await page.locator('body').innerText().catch(() => '')).catch(() => {});
  console.log(`[debug] saved ${base} (${page.url()})`);
}

/**
 * Click an element. The FCC app's tabs are rendered with width:0, which Playwright treats as
 * unclickable, so fall back to dispatching the click event directly (their handlers are onclick).
 */
async function tap(locator, timeout = 5000) {
  const el = locator.first();
  try {
    await el.click({ timeout });
  } catch {
    await el.dispatchEvent('click', undefined, { timeout });
  }
}

/**
 * Reads the Pickup Manifest table on the current page.
 * Columns are found by header name (the header row and data rows line up 1:1), and shipper
 * names come from the tooltip attribute because the visible text is truncated ("BAY AREA...").
 * Returns [{ shipper, address, city, close }] sorted by close time.
 */
export async function extractPickups(page) {
  return page.evaluate(() => {
    const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
    // The page has a header-only copy of the table (sticky header) and the real one; use the one with rows.
    const candidates = [...document.querySelectorAll('th')]
      .filter((t) => /PU List/.test(t.innerText))
      .map((th) => {
        const heads = [...th.parentElement.children].map((c) => clean(c.innerText));
        const rows = [...th.closest('table').querySelectorAll('tr')]
          .map((tr) => [...tr.children].filter((c) => c.tagName === 'TD'))
          .filter((tds) => tds.length === heads.length);
        return { heads, rows };
      });
    if (!candidates.length) return null;
    const { heads, rows } = candidates.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
    const col = (re) => heads.findIndex((h) => re.test(h));
    const idx = {
      shipper: col(/^Shipper Name/),
      address: col(/^Address/),
      city: col(/^City/),
      close: col(/^Close/),
    };
    const full = (td) => {
      const el = td.querySelector('[oldtitle]') || td.querySelector('[title]:not([title=""])');
      return clean((el && (el.getAttribute('oldtitle') || el.getAttribute('title'))) || td.innerText);
    };
    return rows
      .map((tds) => ({
        shipper: full(tds[idx.shipper]),
        address: full(tds[idx.address]),
        city: full(tds[idx.city]),
        close: clean(tds[idx.close].innerText),
      }))
      .sort((a, b) => a.close.localeCompare(b.close));
  });
}

/**
 * Opens the portal, logs in, goes to FedEx Customer Connection -> Pickup Manifest -> Search,
 * and returns [subject, ...bodyLines] for the notification.
 * Everything portal-specific lives here.
 */
export async function scrapePortal() {
  const url = process.env.PORTAL_URL;
  if (!url) throw new Error('PORTAL_URL is not set');

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  let current = page; // the page we're working in; may switch if FCC opens in a new tab
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
    await snap(page, 'after-login');

    // Click "FedEx Customer Connection" in the FCC Links tile, which lives in an iframe.
    // It may open in a new tab.
    const fccLink = page
      .frameLocator('iframe[title="FCC Links"]')
      .getByText(/fedex customer connection/i)
      .first();
    const [popup] = await Promise.all([
      context.waitForEvent('page', { timeout: 15_000 }).catch(() => null),
      fccLink.click(),
    ]);
    current = popup ?? page;
    await current.waitForLoadState('networkidle');
    await snap(current, 'fcc-home');

    // Bottom nav "P&D Manifests" (recorded flow: this lands on Pickup Manifest, then Search).
    await tap(current.getByText('P&D Manifests'));
    await current.waitForLoadState('networkidle');
    await snap(current, 'pd-manifests');

    // Pickup Manifest is the default tab, but click it if it's offered and we're not on it.
    await tap(current.locator('li, a, button', { hasText: /^\s*Pickup Manifest\s*$/ }), 2000).catch(() => {});

    // Search loads all pickups for the day.
    await snap(current, 'pickup-manifest');
    await tap(current.getByRole('button', { name: 'Search' }), 30_000);
    await current.getByText(/\d+ records? found/i).first().waitFor({ timeout: 60_000 });
    await snap(current, 'search-results');

    const pickups = await extractPickups(current);
    if (!pickups) throw new Error('Could not find the pickup table on the results page');

    const count = pickups.length;
    const lines = pickups.map((p) => `${p.close}  ${p.shipper} - ${p.address}, ${p.city}`);

    // Sanity check: the page states how many records it found; flag a mismatch rather than under-report.
    const stated = Number(((await current.getByText(/\d+ records? found/i).first().innerText()).match(/\d+/) || [])[0]);
    if (stated !== count) lines.push(`WARNING: page says ${stated} records but only ${count} were read.`);

    return [`FedEx pickups: ${count} today`, ...(lines.length ? lines : ['No pickups listed.'])];
  } catch (err) {
    // Save a screenshot so the workflow can upload it for debugging.
    await snap(current, 'failure'); await current.screenshot({ path: 'artifacts/failure.png' }).catch(() => {});
    throw err;
  } finally {
    await browser.close();
  }
}

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
 * Reads the whole Pickup Manifest table on the current page.
 * Header cells and data cells line up 1:1. Visible text is truncated for some cells
 * ("BAY AREA..."), so the tooltip attribute is preferred when present.
 * Returns { headers: string[], rows: string[][] } (columns with no header, e.g. the row icon, are dropped),
 * sorted by the Close column, or null if the table isn't found.
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

    const full = (td) => {
      const el = td.querySelector('[oldtitle]') || td.querySelector('[title]:not([title=""])');
      return clean((el && (el.getAttribute('oldtitle') || el.getAttribute('title'))) || td.innerText);
    };
    const keep = heads.map((h, i) => (h && h !== 'Msg' ? i : -1)).filter((i) => i >= 0);
    const closeAt = keep.findIndex((i) => /^Close/.test(heads[i]));
    const data = rows.map((tds) => keep.map((i) => full(tds[i])));
    if (closeAt >= 0) data.sort((x, y) => x[closeAt].localeCompare(y[closeAt]));
    return { headers: keep.map((i) => heads[i]), rows: data };
  });
}

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Builds the notification from the table: { subject, text, html }.
 * Key columns up front, the rest in a small grey line per pickup; open pickups first.
 * Inline styles only (email clients ignore most CSS).
 */
export function formatPickups({ headers, rows }) {
  const col = (re) => headers.findIndex((h) => re.test(h));
  const at = {
    close: col(/^Close/), ready: col(/^Ready/), shipper: col(/^Shipper Name/), address: col(/^Address/),
    city: col(/^City/), postal: col(/^Postal/), pkgs: col(/^Pkgs Picked/), closed: col(/^PU Closed/),
    type: col(/^Type/), puid: col(/^PUID/), wa: col(/^WA#/), shipperNo: col(/^Shipper #/),
    reason: col(/^Reas/), puList: col(/^PU List/), station: col(/^Station/), expected: col(/^# Pkgs/),
  };
  const v = (r, k) => (at[k] >= 0 ? r[at[k]] : '');

  const pickups = rows.map((r) => ({
    close: v(r, 'close'), ready: v(r, 'ready'), shipper: v(r, 'shipper'),
    address: `${v(r, 'address')}, ${v(r, 'city')} ${v(r, 'postal')}`.replace(/\s+/g, ' ').trim(),
    pkgs: v(r, 'pkgs'), isClosed: !!v(r, 'closed'), closedAt: v(r, 'closed'),
    details: [
      ['Type', v(r, 'type')], ['PUID', v(r, 'puid')], ['WA#', v(r, 'wa')], ['Shipper #', v(r, 'shipperNo')],
      ['PU List', v(r, 'puList')], ['Station', v(r, 'station')], ['Expected pkgs', v(r, 'expected')],
      ['Reason', v(r, 'reason')],
    ].filter(([, x]) => x !== ''),
  }));
  // Open pickups first, each group by close time.
  pickups.sort((a, b) => a.isClosed - b.isClosed || a.close.localeCompare(b.close));

  const open = pickups.filter((p) => !p.isClosed).length;
  const closed = pickups.length - open;
  const day = new Date().toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles',
  });

  const text = [
    `FedEx pickups ${day}: ${pickups.length} total, ${open} open, ${closed} closed`,
    '',
    ...pickups.map(
      (p) =>
        `${p.isClosed ? '[closed]' : '[OPEN]  '} close ${p.close}  ${p.shipper} - ${p.address}` +
        `  (ready ${p.ready}, picked up ${p.pkgs})` +
        (p.details.length ? `\n           ${p.details.map(([k, x]) => `${k} ${x}`).join(' | ')}` : ''),
    ),
  ];

  const purple = '#4D148C', orange = '#FF6200';
  const chip = (n, label, bg, fg) =>
    `<td style="padding:0 6px 0 0"><div style="background:${bg};color:${fg};border-radius:8px;padding:8px 14px;text-align:center">` +
    `<div style="font-size:22px;font-weight:bold;line-height:1.1">${n}</div>` +
    `<div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px">${label}</div></div></td>`;
  const pill = (closedFlag) =>
    closedFlag
      ? '<span style="background:#e3e3e3;color:#666;border-radius:10px;padding:2px 8px;font-size:11px">Closed</span>'
      : `<span style="background:${orange};color:#fff;border-radius:10px;padding:2px 8px;font-size:11px;font-weight:bold">Open</span>`;
  const td = 'padding:10px 8px;border-bottom:1px solid #e6e6e6;vertical-align:top';

  const rowsHtml = pickups
    .map((p, i) => {
      const bg = p.isClosed ? '#f4f4f4' : i % 2 ? '#fafafa' : '#ffffff';
      const color = p.isClosed ? '#888' : '#222';
      return (
        `<tr style="background:${bg};color:${color}">` +
        `<td style="${td};white-space:nowrap"><b style="font-size:15px">${esc(p.close)}</b>` +
        `<div style="font-size:11px;color:#888">ready ${esc(p.ready)}</div></td>` +
        `<td style="${td}"><b>${esc(p.shipper)}</b><div style="font-size:12px">${esc(p.address)}</div>` +
        (p.details.length
          ? `<div style="font-size:11px;color:#888;margin-top:3px">${p.details.map(([k, x]) => `${esc(k)} ${esc(x)}`).join(' &middot; ')}</div>`
          : '') +
        `</td>` +
        `<td style="${td};text-align:center;white-space:nowrap">${pill(p.isClosed)}` +
        `<div style="font-size:11px;color:#888;margin-top:4px">${esc(p.pkgs)} picked up</div></td>` +
        `</tr>`
      );
    })
    .join('');

  const html =
    `<div style="max-width:680px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;background:#ffffff;color:#222">` +
    `<div style="background:${purple};color:#fff;padding:14px 16px;border-radius:8px 8px 0 0">` +
    `<div style="font-size:18px;font-weight:bold">FedEx pickups</div><div style="font-size:12px;opacity:.85">${esc(day)}</div></div>` +
    `<table role="presentation" style="padding:12px 16px 4px"><tr>` +
    chip(pickups.length, 'Total', '#efe8f7', purple) + chip(open, 'Open', '#ffe9dc', '#b34400') + chip(closed, 'Closed', '#ececec', '#555') +
    `</tr></table>` +
    `<table style="width:100%;border-collapse:collapse;font-size:13px">` +
    `<tr style="background:#f0eef4;color:${purple};font-size:11px;text-transform:uppercase;letter-spacing:.5px">` +
    `<th style="padding:8px;text-align:left">Close</th><th style="padding:8px;text-align:left">Shipper</th><th style="padding:8px">Status</th></tr>` +
    rowsHtml +
    `</table></div>`;

  return { text, html, count: pickups.length, open };
}

/**
 * Opens the portal, logs in, goes to FedEx Customer Connection -> Pickup Manifest -> Search,
 * and returns { subject, text, html } for the notification.
 * Everything portal-specific lives here.
 */
export async function scrapePortal() {
  const url = process.env.PORTAL_URL;
  if (!url) throw new Error('PORTAL_URL is not set');

  const browser = await chromium.launch();
  // The portal's date picker defaults to the *browser's* clock. GitHub runners are on UTC, which rolls to
  // "tomorrow" at 5pm Pacific, so pin the browser to Pacific to match what you see.
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    timezoneId: 'America/Los_Angeles',
    locale: 'en-US',
  });
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

    const table = await extractPickups(current);
    if (!table) throw new Error('Could not find the pickup table on the results page');

    const { text, html, count, open } = formatPickups(table);
    let note = '';

    // Sanity check: the page states how many records it found; flag a mismatch rather than under-report.
    const stated = Number(((await current.getByText(/\d+ records? found/i).first().innerText()).match(/\d+/) || [])[0]);
    if (stated !== count) note = `WARNING: page says ${stated} records but only ${count} were read.`;

    return {
      subject: `FedEx pickups: ${count} total, ${open} open`,
      text: [note, ...text].filter(Boolean).join('\n'),
      html: (note ? `<p><b>${esc(note)}</b></p>` : '') + html,
    };
  } catch (err) {
    // Save a screenshot so the workflow can upload it for debugging.
    await snap(current, 'failure'); await current.screenshot({ path: 'artifacts/failure.png' }).catch(() => {});
    throw err;
  } finally {
    await browser.close();
  }
}

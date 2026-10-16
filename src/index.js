import { mkdir, writeFile } from 'node:fs/promises';
import { scrapePortal, LoginError } from './scrape.js';
import { notify } from './notify.js';

await mkdir('artifacts', { recursive: true });

try {
  const { subject, text, html } = await scrapePortal();
  await notify(subject, text, html);
} catch (err) {
  console.error(err);
  if (err instanceof LoginError) {
    // Repeated failed logins can lock the account, so the workflow disables itself (see check-portal.yml).
    await writeFile('artifacts/login-failed', err.message);
    await notify(
      'Portal watcher STOPPED: login failed',
      `${err.message}\n\nThe workflow has been disabled so it stops retrying. Fix the PORTAL_USER / PORTAL_PASS secrets, ` +
        'then re-enable it with: gh workflow enable "Check portal"',
    ).catch(() => {});
  } else {
    // Notify on failure too, so a silently broken scraper doesn't look like "nothing new".
    await notify('Portal watcher FAILED', String(err.message).slice(0, 300)).catch(() => {});
  }
  process.exit(1);
}

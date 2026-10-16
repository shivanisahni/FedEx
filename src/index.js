import { mkdir } from 'node:fs/promises';
import { scrapePortal } from './scrape.js';
import { notify } from './notify.js';

await mkdir('artifacts', { recursive: true });

try {
  const [subject, ...rest] = await scrapePortal();
  await notify(subject, rest.join('\n') || subject);
} catch (err) {
  console.error(err);
  // Notify on failure too, so a silently broken scraper doesn't look like "nothing new".
  await notify('Portal watcher FAILED', String(err.message).slice(0, 300)).catch(() => {});
  process.exit(1);
}

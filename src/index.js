import { mkdir } from 'node:fs/promises';
import { scrapePortal } from './scrape.js';
import { sendSms } from './sms.js';

await mkdir('artifacts', { recursive: true });

try {
  const lines = await scrapePortal();
  await sendSms(lines.join('\n'));
} catch (err) {
  console.error(err);
  // Text on failure too, so a silently broken scraper doesn't look like "nothing new".
  await sendSms(`Portal watcher FAILED: ${err.message}`.slice(0, 300)).catch(() => {});
  process.exit(1);
}

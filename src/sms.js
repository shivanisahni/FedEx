/**
 * Sends an SMS via Twilio's REST API (no SDK needed).
 * Uses the repo secrets: TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER (from), MY_PHONE (to).
 * Set DRY_RUN=1 to print instead of send.
 */
export async function sendSms(body) {
  if (process.env.DRY_RUN) {
    console.log('[dry-run] would send SMS:\n' + body);
    return;
  }

  const { TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, MY_PHONE } = process.env;
  for (const [k, v] of Object.entries({ TWILIO_SID, TWILIO_TOKEN, TWILIO_NUMBER, MY_PHONE })) {
    if (!v) throw new Error(`${k} is not set`);
  }

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ From: TWILIO_NUMBER, To: MY_PHONE, Body: body }),
  });

  if (!res.ok) throw new Error(`Twilio error ${res.status}: ${await res.text()}`);
  const { sid, status } = await res.json();
  console.log(`SMS queued: ${sid} (${status})`);
}

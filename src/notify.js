import { sendEmail } from './email.js';
import { sendSms } from './sms.js';

/**
 * Sends a notification using NOTIFY_METHOD: "email" (default) or "sms" (Twilio).
 * To switch back to texting, set the NOTIFY_METHOD repo variable to "sms".
 */
export async function notify(subject, body) {
  const method = process.env.NOTIFY_METHOD || 'email';
  if (method === 'email') return sendEmail(subject, body);
  if (method === 'sms') return sendSms(`${subject}\n${body}`);
  throw new Error(`Unknown NOTIFY_METHOD "${method}" (use "email" or "sms")`);
}

import nodemailer from 'nodemailer';

/**
 * Sends an email through Gmail SMTP.
 * Uses the repo secrets: EMAIL_USER (Gmail address), EMAIL_APP_PASSWORD (Google app password),
 * and optionally EMAIL_TO (defaults to EMAIL_USER, i.e. email yourself).
 * Set DRY_RUN=1 to print instead of send.
 */
export async function sendEmail(subject, body, html) {
  if (process.env.DRY_RUN) {
    console.log(`[dry-run] would send email:\nSubject: ${subject}\n\n${body}`);
    return;
  }

  const { EMAIL_USER, EMAIL_APP_PASSWORD, EMAIL_TO } = process.env;
  for (const [k, v] of Object.entries({ EMAIL_USER, EMAIL_APP_PASSWORD })) {
    if (!v) throw new Error(`${k} is not set`);
  }

  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: EMAIL_USER, pass: EMAIL_APP_PASSWORD },
  });

  const info = await transport.sendMail({
    from: EMAIL_USER,
    to: EMAIL_TO || EMAIL_USER,
    subject,
    text: body,
    ...(html && { html }),
  });
  console.log(`Email sent: ${info.messageId}`);
}

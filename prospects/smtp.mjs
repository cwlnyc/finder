// A minimal SMTP client, enough to hand one message to Gmail.
//
// Hand-written rather than pulled from npm to keep this project
// dependency-free: there is no install step, and nothing in the supply chain
// that can change under a credential able to send mail as you.
//
// Gmail on 465 speaks TLS from the first byte (no STARTTLS) and accepts
// AUTH LOGIN with an app password. Tests drive this same code over a plain
// socket against a fake server, so the protocol handling is exercised.

import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

export class SmtpError extends Error {
  constructor(message, { code, retryable = false } = {}) {
    super(message);
    this.name = 'SmtpError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** Turn an SMTP reply code into something that names the fix. */
function describe(code, text, stage) {
  if (code === 535 || code === 534) {
    return new SmtpError(
      'Gmail rejected the login. It needs an app password — your normal one will not work:\n' +
        '  1. Turn on 2-Step Verification at myaccount.google.com/security\n' +
        '  2. Create an app password under "App passwords"\n' +
        '  3. export GMAIL_APP_PASSWORD="that 16-character code"\n' +
        `  Gmail said: ${text}`,
      { code },
    );
  }
  if (code === 550 || code === 553) return new SmtpError(`Address refused: ${text}`, { code });
  if ([421, 450, 451, 452].includes(code)) {
    return new SmtpError(`Gmail asked us to slow down or try later: ${text}`, { code, retryable: true });
  }
  return new SmtpError(`SMTP ${stage} failed (${code}): ${text}`, { code });
}

/** Read one reply, joining the continuation lines of a multiline response. */
function readReply(socket, buffer) {
  return new Promise((resolve, reject) => {
    const stop = (err) => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      if (err) reject(err);
    };
    const tryParse = () => {
      // A reply ends at the first line whose code is followed by a space rather
      // than a hyphen: "250-EXTENSION" continues, "250 OK" ends it.
      const lines = buffer.value.split('\r\n');
      for (let i = 0; i < lines.length; i++) {
        const match = /^(\d{3})([ -])(.*)$/.exec(lines[i]);
        if (!match) continue;
        if (match[2] === ' ') {
          buffer.value = lines.slice(i + 1).join('\r\n');
          stop();
          resolve({ code: Number(match[1]), text: lines.slice(0, i + 1).join(' ') });
          return true;
        }
      }
      return false;
    };
    const onData = (chunk) => { buffer.value += chunk.toString('utf8'); tryParse(); };
    const onError = (err) => stop(err);
    const onClose = () => stop(new SmtpError('The server closed the connection unexpectedly'));

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    if (buffer.value) tryParse();
  });
}

/** RFC 2047 for a header that is not plain ASCII — the subject has an em dash. */
export function encodeHeader(value) {
  const text = String(value ?? '');
  if (/^[\x20-\x7E]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

/** The message as it goes on the wire. */
export function buildMessage({ from, fromName, to, subject, body, date = new Date(), id }) {
  const sender = fromName ? `${encodeHeader(fromName)} <${from}>` : from;
  const messageId = id ?? `${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const headers = [
    `From: ${sender}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${messageId}@${String(from).split('@')[1]}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ];
  // base64 sidesteps every question about line length and 8-bit characters.
  const encoded = Buffer.from(String(body), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${encoded}`;
}

/**
 * Send one message: open a connection, send it, close.
 *
 * One message per connection is slower than pipelining a batch, which is the
 * point. This is paced outreach, not a mailing.
 */
export async function sendMail({
  host = 'smtp.gmail.com',
  port = 465,
  secure = true,
  user,
  pass,
  from = user,
  fromName,
  to,
  subject,
  body,
  timeoutMs = 20000,
}) {
  if (!user || !pass) throw new SmtpError('No Gmail account configured. Set GMAIL_USER and GMAIL_APP_PASSWORD.');
  if (!to) throw new SmtpError('No recipient.');

  const socket = secure ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port });
  socket.setEncoding('utf8');
  socket.setTimeout(timeoutMs, () => socket.destroy(new SmtpError('Timed out talking to the mail server')));

  const buffer = { value: '' };
  const say = async (line, stage, expect) => {
    if (line !== null) socket.write(`${line}\r\n`);
    const reply = await readReply(socket, buffer);
    if (!expect.includes(reply.code)) throw describe(reply.code, reply.text, stage);
    return reply;
  };

  try {
    await new Promise((resolve, reject) => {
      socket.once(secure ? 'secureConnect' : 'connect', resolve);
      socket.once('error', reject);
    });

    await say(null, 'greeting', [220]);
    await say('EHLO localhost', 'EHLO', [250]);
    await say('AUTH LOGIN', 'AUTH', [334]);
    await say(Buffer.from(user, 'utf8').toString('base64'), 'AUTH user', [334]);
    await say(Buffer.from(pass, 'utf8').toString('base64'), 'AUTH password', [235]);
    await say(`MAIL FROM:<${from}>`, 'MAIL FROM', [250]);
    await say(`RCPT TO:<${to}>`, 'RCPT TO', [250, 251]);
    await say('DATA', 'DATA', [354]);

    const message = buildMessage({ from, fromName, to, subject, body });
    // Dot-stuffing: a line that is just "." would otherwise end the message.
    const safe = message.split('\r\n').map((l) => (l.startsWith('.') ? `.${l}` : l)).join('\r\n');
    await say(`${safe}\r\n.`, 'message', [250]);

    // Wait for the sign-off rather than writing QUIT and tearing the socket
    // down underneath it. The message is already accepted at this point, so a
    // server that just closes instead of replying is not a failure.
    try {
      await say('QUIT', 'QUIT', [221]);
    } catch { /* closed without a reply; the 250 above is what mattered */ }
    return { to, ok: true };
  } finally {
    socket.destroy();
  }
}

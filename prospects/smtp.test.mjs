import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test, { after, before } from 'node:test';

import { buildMessage, encodeHeader, sendMail, SmtpError } from './smtp.mjs';

// A fake mail server. The real client code runs against it over a plain
// socket, so the conversation itself is what gets exercised -- the part that
// would otherwise only ever be tested against Gmail in production.
let server;
let port;
let transcript;
let script;

function fakeReplies({ auth = '235 2.7.0 Accepted', rcpt = '250 2.1.5 OK', data = '250 2.0.0 OK queued' } = {}) {
  return { auth, rcpt, data };
}

before(async () => {
  server = createServer((socket) => {
    let buffer = '';
    let inMessage = false;
    // AUTH LOGIN is three exchanges, so the server needs to remember where it
    // is: the two base64 lines that follow are otherwise indistinguishable
    // from any other command.
    let authStep = 0;
    socket.setEncoding('utf8');
    socket.write('220 fake ESMTP ready\r\n');

    socket.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        if (inMessage) {
          if (line === '.') {
            inMessage = false;
            transcript.body = transcript.message.join('\r\n');
            socket.write(`${script.data}\r\n`);
          } else transcript.message.push(line);
          continue;
        }

        transcript.lines.push(line);
        if (authStep === 1) { authStep = 2; socket.write('334 UGFzc3dvcmQ6\r\n'); }
        else if (authStep === 2) { authStep = 3; socket.write(`${script.auth}\r\n`); }
        else if (line.startsWith('EHLO')) socket.write('250-fake greets you\r\n250 AUTH LOGIN\r\n'); // multiline on purpose
        else if (line === 'AUTH LOGIN') { authStep = 1; socket.write('334 VXNlcm5hbWU6\r\n'); }
        else if (line.startsWith('MAIL FROM')) socket.write('250 2.1.0 OK\r\n');
        else if (line.startsWith('RCPT TO')) socket.write(`${script.rcpt}\r\n`);
        else if (line === 'DATA') { inMessage = true; socket.write('354 Go ahead\r\n'); }
        else if (line === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(async () => { await new Promise((r) => server.close(r)); });

function freshTranscript() {
  transcript = { lines: [], message: [], body: '' };
  script = fakeReplies();
  return transcript;
}

const send = (over = {}) => sendMail({
  host: '127.0.0.1', port, secure: false,
  user: 'me@gmail.com', pass: 'app password', to: 'kate@acme.com',
  subject: 'Test', body: 'Hi Kate,\n\nLine two.', timeoutMs: 3000, ...over,
});

// --- the conversation --------------------------------------------------

test('a message walks the whole SMTP conversation in order', async () => {
  const t = freshTranscript();
  const result = await send();
  assert.equal(result.ok, true);
  const verbs = t.lines.filter((l) => /^[A-Z]{4}/.test(l)).map((l) => l.split(/[ :]/)[0]);
  assert.deepEqual(verbs, ['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'QUIT']);
});

test('a multiline greeting does not confuse the reply reader', async () => {
  // "250-fake greets you" continues, "250 AUTH LOGIN" ends it. Treating the
  // first line as the whole reply desynchronises everything after it.
  freshTranscript();
  await assert.doesNotReject(() => send());
});

test('credentials go over the wire base64-encoded, as AUTH LOGIN requires', async () => {
  const t = freshTranscript();
  await send({ user: 'me@gmail.com', pass: 'secret pass' });
  assert.ok(t.lines.includes(Buffer.from('me@gmail.com').toString('base64')));
  assert.ok(t.lines.includes(Buffer.from('secret pass').toString('base64')));
  assert.ok(!t.lines.includes('secret pass'), 'never in the clear');
});

test('the recipient reaches the server intact', async () => {
  const t = freshTranscript();
  await send({ to: 'first.last@some-broker.co.uk' });
  assert.ok(t.lines.includes('RCPT TO:<first.last@some-broker.co.uk>'));
});

// --- the message itself ------------------------------------------------

test('a non-ASCII subject is encoded, a plain one is left alone', () => {
  // The real subject carries an em dash; sent raw it arrives as mojibake.
  assert.equal(encodeHeader('Plain subject'), 'Plain subject');
  const encoded = encodeHeader('New licences — free list');
  assert.match(encoded, /^=\?UTF-8\?B\?/);
  assert.equal(Buffer.from(encoded.slice(10, -2), 'base64').toString('utf8'), 'New licences — free list');
});

test('the message carries the headers a real client sends', () => {
  const message = buildMessage({
    from: 'me@gmail.com', fromName: 'Ethan', to: 'kate@acme.com',
    subject: 'Hello', body: 'Hi', date: new Date('2026-09-20T12:00:00Z'), id: 'fixed',
  });
  assert.match(message, /^From: Ethan <me@gmail\.com>\r\n/);
  assert.match(message, /\r\nTo: kate@acme\.com\r\n/);
  assert.match(message, /\r\nMessage-ID: <fixed@gmail\.com>\r\n/);
  assert.match(message, /\r\nMIME-Version: 1\.0\r\n/);
  assert.match(message, /\r\nContent-Type: text\/plain; charset=utf-8\r\n/);
  assert.match(message, /\r\n\r\n/, 'headers end with a blank line');
});

test('a follow-up says which message it answers, a first message does not', () => {
  const threaded = buildMessage({
    from: 'me@gmail.com', to: 'kate@acme.com', subject: 'Re: Hello', body: 'Hi',
    date: new Date('2026-09-24T12:00:00Z'), id: 'second', inReplyTo: '<first@gmail.com>',
  });
  // Both headers: clients file by References, and some only read In-Reply-To.
  assert.match(threaded, /\r\nIn-Reply-To: <first@gmail\.com>\r\n/);
  assert.match(threaded, /\r\nReferences: <first@gmail\.com>\r\n/);

  const first = buildMessage({
    from: 'me@gmail.com', to: 'kate@acme.com', subject: 'Hello', body: 'Hi',
    date: new Date('2026-09-24T12:00:00Z'), id: 'first',
  });
  assert.ok(!first.includes('In-Reply-To'), 'nothing to answer yet');
});

test('a send hands back the id its follow-up will need', async () => {
  // Without this the second message cannot thread, and an unthreaded
  // follow-up arrives as a second stranger rather than the same conversation.
  const t = freshTranscript();
  const result = await send();
  assert.match(result.messageId, /^<.+@gmail\.com>$/);
  assert.ok(t.body.includes(`Message-ID: ${result.messageId}`), 'the id returned is the id sent');
});

test('the body survives the round trip, accents and all', async () => {
  const t = freshTranscript();
  const body = 'Hi Kate,\n\nLicences — “quoted” café.\nLast line.';
  await send({ body });
  const encoded = t.body.split('\r\n\r\n')[1].replace(/\r\n/g, '');
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), body);
});

test('a line that is only a dot cannot truncate the message', async () => {
  // An unescaped "." on its own line ends DATA early, silently delivering a
  // half message. base64 makes it unlikely; dot-stuffing makes it impossible.
  const t = freshTranscript();
  await send({ body: 'Hi,\n.\nStill here.' });
  const encoded = t.body.split('\r\n\r\n')[1].replace(/\r\n/g, '');
  assert.match(Buffer.from(encoded, 'base64').toString('utf8'), /Still here\./);
});

// --- failures ----------------------------------------------------------

test('a rejected login explains app passwords rather than repeating the code', async () => {
  freshTranscript();
  // Gmail sends this one across two lines, so it also checks that a multiline
  // *error* is read to its end rather than treated as a hanging reply.
  script.auth = '535-5.7.8 Username and Password not accepted\r\n535 5.7.8 https://support.google.com/mail/?p=BadCredentials';
  await assert.rejects(() => send(), (err) => {
    assert.ok(err instanceof SmtpError);
    assert.equal(err.code, 535);
    assert.match(err.message, /2-Step Verification/);
    assert.match(err.message, /GMAIL_APP_PASSWORD/);
    assert.equal(err.retryable, false);
    return true;
  });
});

test('a refused address fails that message only', async () => {
  freshTranscript();
  script.rcpt = '550 5.1.1 No such user';
  await assert.rejects(() => send(), (err) => {
    assert.equal(err.code, 550);
    assert.match(err.message, /Address refused/);
    return true;
  });
});

test('being asked to slow down is marked retryable', async () => {
  freshTranscript();
  script.data = '421 4.7.0 Try again later';
  await assert.rejects(() => send(), (err) => {
    assert.equal(err.retryable, true, 'so a caller can back off rather than give up');
    return true;
  });
});

test('missing credentials fail before a connection is opened', async () => {
  await assert.rejects(() => send({ user: '', pass: '' }), /GMAIL_USER and GMAIL_APP_PASSWORD/);
  await assert.rejects(() => send({ to: '' }), /No recipient/);
});

test('an unreachable server gives up instead of hanging', async () => {
  const started = Date.now();
  await assert.rejects(() => sendMail({
    host: '127.0.0.1', port: 1, secure: false, user: 'a@b.com', pass: 'x',
    to: 'c@d.com', subject: 's', body: 'b', timeoutMs: 1500,
  }));
  assert.ok(Date.now() - started < 5000);
});

// Opening a written message for one prospect.
//
// Gmail rather than a mailto: link, because mailto hands the click to whatever
// desktop mail app the OS registered -- usually Apple Mail, which is not where
// this mail is being sent from.
//
// The businesses go in the body rather than as an attachment. A Gmail compose
// URL cannot carry a file at all, and inline is the better mail regardless: no
// download from a stranger, no attachment penalty with spam filters, and the
// reader sees whether it is useful without opening anything.

import { filterRows, presentRows } from '../records/digest.mjs';
import { readStore } from '../records/store.mjs';

const GMAIL = 'https://mail.google.com/mail/';

export const SUBJECT = 'New contractor licences in NYC — free weekly list';

/** Which records go in the mail. Edit here to sell a different slice. */
export const SAMPLE = {
  source: 'dcwp-licenses',
  category: 'Home Improvement Contractor',
  status: 'Active',
  excludeBorough: 'Outside NYC',
  max: 12,
};

/**
 * The records that go in the mail: the most recent of the slice being sold.
 *
 * Most recent rather than "the last seven days", because the city publishes
 * about three weeks behind -- a window measured from today would usually be
 * empty and the mail would go out with nothing in it.
 *
 * Lives here rather than in the server so the terminal and the page send the
 * same message; two copies of this drift, and the difference would only ever
 * show up in somebody's inbox.
 */
export async function loadSampleRecords(dataDir) {
  let rows;
  try {
    rows = dataDir ? await readStore(SAMPLE.source, dataDir) : await readStore(SAMPLE.source);
  } catch {
    return [];
  }
  return presentRows(
    filterRows(rows, { category: SAMPLE.category, status: SAMPLE.status })
      .filter((r) => r.borough !== SAMPLE.excludeBorough)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      .slice(0, SAMPLE.max),
  );
}

// Addresses that are a desk, not a person.
const ROLE = new Set([
  'info', 'sales', 'contact', 'support', 'office', 'mail', 'admin', 'hello', 'team',
  'service', 'claims', 'help', 'enquiries', 'inquiries', 'general', 'quotes', 'billing',
  'auto', 'insurance', 'agency', 'newbusiness', 'customerservice', 'acquisitions',
  // Back-office queues, which read like short first names but answer existing
  // clients: "certs" and "coi" are both certificate-of-insurance desks.
  'certs', 'cert', 'coi', 'policy', 'policies', 'renewals', 'accounts', 'account',
  'careers', 'jobs', 'legal', 'privacy', 'noreply', 'orders', 'agent', 'agents',
  'members', 'notices', 'refunds', 'payments', 'bookings', 'reception',
]);

// Substrings that mean the local part is a business name rather than a person's.
const COMPANYISH = ['insur', 'broker', 'agency', 'group', 'ins', 'quote', 'claim', 'admin', 'team', 'corp'];

/**
 * The first name an address belongs to, or '' when it belongs to a desk.
 *
 * Deliberately shy: greeting a firm as "Hi Hdainsurancebk," is worse than
 * being generic, so anything long, company-shaped, or role-like returns ''.
 */
export function firstNameFrom(email) {
  const localPart = String(email ?? '').split('@')[0].toLowerCase();
  if (COMPANYISH.some((word) => localPart.includes(word))) return '';

  const first = localPart.split(/[._-]/)[0];
  if (!/^[a-z]{3,7}$/.test(first) || ROLE.has(first)) return '';
  return `${first[0].toUpperCase()}${first.slice(1)}`;
}

/**
 * Whether an address reaches a person rather than a queue.
 *
 * Worth knowing before writing, not just while writing: info@ at an agency
 * lands in the mailbox that answers customers, where a pitch is closed as the
 * wrong kind of enquiry. The same address at a one-person shop is the owner.
 * Same test either way -- this is the one greetingFor already applies, used to
 * decide who to write to rather than only how to open.
 */
export const isPersonAddress = (email) => firstNameFrom(email) !== '';

/** "Hi Kate," where the address plainly belongs to a person, "Hi there," otherwise. */
export function greetingFor(email) {
  const name = firstNameFrom(email);
  return name ? `Hi ${name},` : 'Hi there,';
}

// CAN-SPAM wants a way out of a commercial mail, and it is self-interest as
// much as law: someone who can leave in one word does not press "report spam"
// instead, and a spam complaint costs far more than a lost address.
const OPT_OUT = 'If you\'d rather not get these, just reply "no thanks" and that is the end of it.';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-08-18' -> 'Aug 18'. Never a Date: these are calendar days. */
function readableDay(day) {
  const [, month, date] = String(day ?? '').split('-');
  return month ? `${MONTHS[Number(month) - 1]} ${Number(date)}` : '';
}

/** One business per line: name, where it is, and how to reach it. */
export function formatRecords(records) {
  return records
    .map((r) => [r.name, [r.address, r.borough].filter(Boolean).join(', '), r.phone].filter(Boolean).join('  ·  '))
    .join('\n');
}

/**
 * The message itself.
 *
 * Written to read like someone typed it: short sentences, the goods before
 * any explanation, and no ask at the end. A pitch that opens by describing
 * itself gets deleted.
 */
export function buildBody(email, records = []) {
  const greeting = greetingFor(email);
  if (records.length === 0) {
    return `${greeting}

I keep an eye on the city's contractor licensing data and pull out whoever's just been licensed. Thought it might be useful to you — they all need liability coverage before they can legally work.

It's public DCWP data, nothing clever. The city publishes about a month behind, so what I have is as current as the record gets. I check it every week so you don't have to.

Want me to send you the latest?

${OPT_OUT}`;
  }

  const days = records.map((r) => r.date).filter(Boolean).sort();
  const span = days.length
    ? days[0] === days[days.length - 1]
      ? ` from ${readableDay(days[0])}`
      : ` from ${readableDay(days[0])}–${readableDay(days[days.length - 1])}`
    : '';

  return `${greeting}

I keep an eye on the city's contractor licensing data and pull out whoever's just been licensed. Thought it might be useful to you.

Here's the most recent batch${span} — ${records.length} newly licensed contractors:

${formatRecords(records)}

They all need liability coverage before they can legally work.

It's public DCWP data, nothing clever. The city publishes about a month behind, so this is as current as the record gets anywhere. I check it every week so you don't have to. Happy to send you the next one if it's worth having.

${OPT_OUT}`;
}

/** A Gmail compose URL with the message already written. */
export function composeUrl(email, records = [], { subject = SUBJECT } = {}) {
  const address = String(email ?? '').trim();
  if (!address) return '';
  const params = new URLSearchParams({
    view: 'cm',
    fs: '1',
    to: address,
    su: subject,
    // No account number in the path: /u/0/ would be the wrong inbox for anyone
    // whose Gmail is not the first signed-in account.
    body: buildBody(address, records),
  });
  return `${GMAIL}?${params}`;
}

// --- the second message -------------------------------------------------
//
// Most people who ever answer a cold message answer the second or third one,
// not the first. One email is not outreach, it is a coin toss.
//
// Short on purpose, and carries no records: the city publishes about a month
// behind, so a follow-up sent days later would show the identical rows and
// draw attention to exactly the wrong thing.

/** Used when the first message's Message-ID was never recorded, so nothing can thread. */
export const FOLLOW_UP_SUBJECT = 'Following up — NYC contractor licences';

/**
 * The subject for a follow-up.
 *
 * "Re:" only where the message genuinely threads onto the first one. Faking it
 * on a message the recipient never replied to is the oldest trick in cold
 * mail, everyone recognises it, and it is the kind of thing that makes a
 * person distrust everything else in the message.
 */
export function followUpSubject(inReplyTo) {
  return inReplyTo ? `Re: ${SUBJECT}` : FOLLOW_UP_SUBJECT;
}

/** Three lines: a reminder, the offer again, and a way out. */
export function buildFollowUp(email) {
  return `${greetingFor(email)}

I sent you a list of newly licensed NYC contractors last week. Following up once in case it landed at a busy moment.

The offer stands — I pull the new DCWP licences every week and can send them to you as they come. Free, and no catch I am hiding.

${OPT_OUT}`;
}

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

// Addresses that are a desk, not a person.
const ROLE = new Set([
  'info', 'sales', 'contact', 'support', 'office', 'mail', 'admin', 'hello', 'team',
  'service', 'claims', 'help', 'enquiries', 'inquiries', 'general', 'quotes', 'billing',
  'auto', 'insurance', 'agency', 'newbusiness', 'customerservice', 'acquisitions',
]);

// Substrings that mean the local part is a business name rather than a person's.
const COMPANYISH = ['insur', 'broker', 'agency', 'group', 'ins', 'quote', 'claim', 'admin', 'team', 'corp'];

/**
 * "Hi Kate," where the address plainly belongs to a person, "Hi there,"
 * otherwise.
 *
 * Deliberately shy: greeting a firm as "Hi Hdainsurancebk," is worse than
 * being generic, so anything long, company-shaped, or role-like falls back.
 */
export function greetingFor(email) {
  const localPart = String(email ?? '').split('@')[0].toLowerCase();
  if (COMPANYISH.some((word) => localPart.includes(word))) return 'Hi there,';

  const first = localPart.split(/[._-]/)[0];
  if (!/^[a-z]{3,7}$/.test(first) || ROLE.has(first)) return 'Hi there,';
  return `Hi ${first[0].toUpperCase()}${first.slice(1)},`;
}

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

I keep an eye on the city's contractor licensing data and pull out whoever's just been licensed. Thought it might be useful to you — they all need liability coverage before they can legally work, and most won't have sorted it yet.

It's public DCWP data, nothing clever. I just check it every week so you don't have to.

Want me to send you this week's?`;
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

They all need liability coverage before they can legally work, and most won't have sorted it yet.

It's public DCWP data, nothing clever. I just check it every week so you don't have to. Happy to send you next week's if it's worth having.`;
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

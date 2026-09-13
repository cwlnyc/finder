// Opening a pre-filled message for one prospect.
//
// Gmail rather than a mailto: link, because mailto hands the click to whatever
// desktop mail app the OS has registered -- usually Apple Mail, which is not
// where this mail is being sent from.

const GMAIL = 'https://mail.google.com/mail/';

export const SUBJECT = 'Free list — new NYC contractor licences';

export const BODY = `I pull NYC's contractor licensing data every week and clean it into a spreadsheet — business name, address, phone, and the date they were licensed.

Attached is last week's list of newly licensed home improvement contractors across the five boroughs. Every one of them needs liability coverage to operate legally.

It's free. If it's useful I can send it every week.`;

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

  // first.last / first_last / first-last -> first
  const first = localPart.split(/[._-]/)[0];
  if (!/^[a-z]{3,7}$/.test(first) || ROLE.has(first)) return 'Hi there,';
  return `Hi ${first[0].toUpperCase()}${first.slice(1)},`;
}

/** A Gmail compose URL with the message already written. */
export function composeUrl(email, { subject = SUBJECT, body = BODY } = {}) {
  const address = String(email ?? '').trim();
  if (!address) return '';
  const params = new URLSearchParams({
    view: 'cm',
    fs: '1',
    to: address,
    su: subject,
    // No account number in the path: /u/0/ would be the wrong inbox for anyone
    // whose Gmail is not the first signed-in account.
    body: `${greetingFor(address)}\n\n${body}`,
  });
  return `${GMAIL}?${params}`;
}

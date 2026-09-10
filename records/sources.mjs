// Dataset definitions.
//
// IMPORTANT: the `fields` maps below were written without network access to the
// portal, so the Socrata column names are informed guesses, not verified fact.
// Run `node records/cli.mjs probe --all` on a machine with internet before
// trusting any of it; the probe prints the dataset's real column list and
// `pull` refuses to write a batch whose required fields come back empty.
//
// Fixing a wrong name is a one-line edit to the `fields` map here. Nothing
// else in the codebase hardcodes a portal column name.

/** @typedef {'verified'|'likely'|'guess'} Confidence */

export const SOURCES = [
  {
    id: 'dcwp-applications',
    label: 'DCWP license applications (NYC)',
    // Earliest signal there is: the business has applied but has not opened yet.
    why: 'A pending application is a business that has not opened and has no vendors yet.',
    domain: 'data.cityofnewyork.us',
    dataset: 'ptev-4hud',
    dateField: 'start_date',
    // Only fields listed in `required` gate the staleness guard. Everything
    // else is best-effort: a blank borough is a worse lead, not a broken pull.
    required: ['id', 'date', 'name'],
    fields: {
      id: 'application_id',
      date: 'start_date',
      name: 'business_name',
      category: 'license_type',
      status: 'status',
      borough: 'address_borough',
      street: 'address_street_name',
      zip: 'address_zip',
    },
    confidence: 'guess', // documented only as human labels ("Application ID")
  },
  {
    id: 'dcwp-licenses',
    label: 'DCWP issued licenses (NYC)',
    why: 'Cleanest history and the widest industry coverage; the business is open.',
    domain: 'data.cityofnewyork.us',
    dataset: 'w7w3-xahh',
    dateField: 'license_creation_date',
    required: ['id', 'date', 'name'],
    fields: {
      id: 'license_nbr',
      date: 'license_creation_date',
      name: 'business_name',
      dba: 'business_name_2',
      // Portal docs disagree with themselves here: some list `industry`,
      // others `business_category`. The probe settles it.
      category: 'industry',
      status: 'license_status',
      borough: 'address_borough',
      street: 'address_street_name',
      zip: 'address_zip',
    },
    confidence: 'likely',
  },
  {
    id: 'dob-permits',
    label: 'DOB permit issuance (NYC)',
    why: 'Different buyer entirely — subs, equipment rental, dumpsters. High volume.',
    domain: 'data.cityofnewyork.us',
    dataset: 'ipu4-2q9a',
    dateField: 'issuance_date',
    // permit_si_no is the row-unique key; job__ repeats across a job's permits.
    required: ['id', 'date'],
    fields: {
      id: 'permit_si_no',
      date: 'issuance_date',
      name: 'owner_s_business_name',
      category: 'job_type',
      status: 'filing_status',
      borough: 'borough',
      street: 'street_name',
      zip: 'zip_code',
      job: 'job__',
    },
    confidence: 'likely',
  },
];

export function getSource(id) {
  const source = SOURCES.find((s) => s.id === id);
  if (!source) {
    const known = SOURCES.map((s) => s.id).join(', ');
    throw new Error(`Unknown source '${id}'. Known sources: ${known}`);
  }
  return source;
}

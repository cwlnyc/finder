// Dataset definitions.
//
// Column names below were verified against the live portal with
// `node records/cli.mjs probe --all` on 2026-09-11. Re-run probe if a pull
// starts refusing batches -- the portals do reshape datasets.
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
    dateField: 'submission_date',
    // Only fields listed in `required` gate the staleness guard. Everything
    // else is best-effort: a blank borough is a worse lead, not a broken pull.
    required: ['id', 'date', 'name'],
    fields: {
      id: 'application_id',
      date: 'submission_date',
      name: 'business_name',
      // business_category is the industry ("Sidewalk Cafe"); license_type is
      // the far coarser Business/Individual split. Slicing needs the former.
      category: 'business_category',
      licenseType: 'license_type',
      status: 'status',
      building: 'building_number',
      street: 'street',
      borough: 'borough',
      zip: 'zip',
      // Public record, and the field that makes a lead list worth paying for.
      // See the README on what redistributing it commits you to.
      phone: 'contact_phone',
    },
    confidence: 'verified',
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
      category: 'business_category',
      licenseType: 'license_type',
      status: 'license_status',
      // Expiry drives a second product: renewals are a deadline someone sells against.
      expires: 'lic_expir_dd',
      building: 'address_building',
      street: 'address_street_name',
      borough: 'address_borough',
      zip: 'address_zip',
      phone: 'contact_phone',
    },
    confidence: 'verified',
  },
  {
    id: 'dob-permits',
    label: 'DOB permit issuance (NYC)',
    why: 'Different buyer entirely -- subs, equipment rental, dumpsters. High volume.',
    domain: 'data.cityofnewyork.us',
    dataset: 'ipu4-2q9a',
    // permit_si_no is the row-unique key; job__ repeats across a job's permits.
    dateField: 'issuance_date',
    required: ['id', 'date'],
    fields: {
      id: 'permit_si_no',
      date: 'issuance_date',
      name: 'owner_s_business_name',
      category: 'job_type',
      permitType: 'permit_type',
      status: 'filing_status',
      building: 'house__',
      street: 'street_name',
      borough: 'borough',
      zip: 'zip_code',
      // The contractor on the job -- a different lead than the owner.
      permittee: 'permittee_s_business_name',
      job: 'job__',
    },
    confidence: 'verified',
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

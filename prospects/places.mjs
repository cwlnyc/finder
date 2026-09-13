// Finding businesses through the Google Places API (New).
//
// searchText returns the website in the same response as the name, provided the
// field mask asks for it -- the legacy Places API needed a second Details call
// per result, which is 20x the quota for the same answer.
//
// The field names below could not be verified against the live API from the
// machine this was written on. They are checked at runtime instead: a response
// whose shape does not match raises something that names the problem, rather
// than quietly returning a list of businesses with no websites.

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';

// Everything the prospect list needs, and nothing else -- Places bills by the
// field mask, so asking for extras costs real money per search.
const FIELDS = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.websiteUri',
  'places.nationalPhoneNumber',
  'nextPageToken',
];

/** Who might pay for a feed of newly licensed businesses, and why. */
export const BUYER_PRESETS = [
  {
    id: 'insurance',
    label: 'Insurance brokers',
    query: 'commercial insurance broker',
    why: 'NYC requires a contractor to carry liability cover, so a new licence is a guaranteed purchase — and the commission renews every year.',
  },
  {
    id: 'supplies',
    label: 'Building suppliers',
    query: 'building materials supplier',
    why: 'A new contractor has no account anywhere yet. First supplier in usually keeps them.',
  },
  {
    id: 'tools',
    label: 'Tool & equipment rental',
    query: 'construction equipment rental',
    why: 'Rents before it buys. Wants to hear about a contractor in its first month.',
  },
  {
    id: 'bookkeeping',
    label: 'Bookkeepers & accountants',
    query: 'bookkeeping service for contractors',
    why: 'A newly registered business has to file, and has not picked anyone yet.',
  },
  {
    id: 'vehicles',
    label: 'Van & truck leasing',
    query: 'commercial van leasing',
    why: 'A contractor without a van is not working. Big first purchase.',
  },
  {
    id: 'signage',
    label: 'Signs & vehicle wraps',
    query: 'vehicle wrap and sign shop',
    why: 'Every new trade business buys a van wrap and a sign once, early.',
  },
];

export function getPreset(id) {
  const preset = BUYER_PRESETS.find((p) => p.id === id);
  if (!preset) {
    throw new Error(`Unknown buyer '${id}'. Known: ${BUYER_PRESETS.map((p) => p.id).join(', ')}`);
  }
  return preset;
}

export class PlacesError extends Error {
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.name = 'PlacesError';
    this.status = status;
    this.retryable = retryable;
  }
}

/** Turn Google's HTTP failures into something that names the actual fix. */
function describeFailure(status, body) {
  const detail = body?.error?.message ?? '';
  if (status === 400) {
    return new PlacesError(
      `Places rejected the request. Usually the field mask or the query.\n  ${detail}`,
      { status },
    );
  }
  if (status === 403) {
    return new PlacesError(
      'Places refused the key. Check, in this order:\n' +
        '  1. "Places API (New)" is enabled in your Google Cloud project\n' +
        '  2. the key has no HTTP-referrer restriction (this runs from a terminal, not a browser)\n' +
        '  3. billing is switched on for the project\n' +
        (detail ? `  Google said: ${detail}` : ''),
      { status },
    );
  }
  if (status === 429) {
    return new PlacesError(`Out of Places quota for now. ${detail}`, { status, retryable: true });
  }
  if (status >= 500) {
    return new PlacesError(`Places is having trouble (HTTP ${status}). Try again shortly.`, { status, retryable: true });
  }
  return new PlacesError(`Places returned HTTP ${status}. ${detail}`, { status });
}

function normalizePlace(raw) {
  return {
    placeId: raw.id ?? '',
    name: raw.displayName?.text ?? '',
    website: raw.websiteUri ?? '',
    phone: raw.nationalPhoneNumber ?? '',
    address: raw.formattedAddress ?? '',
  };
}

/**
 * Search for businesses and return the ones that have a website.
 *
 * A business with no website cannot be crawled for an address, so it is counted
 * and dropped rather than stored as a prospect that can never be looked up.
 */
export async function searchPlaces(query, {
  apiKey = process.env.GOOGLE_PLACES_API_KEY,
  fetchImpl = fetch,
  maxResults = 40,
  pageSize = 20,
} = {}) {
  if (!apiKey) {
    throw new PlacesError(
      'No Places API key. Get one at console.cloud.google.com (enable "Places API (New)"), then:\n' +
        '  export GOOGLE_PLACES_API_KEY=your_key',
    );
  }
  if (!String(query ?? '').trim()) throw new PlacesError('Search for what? Give it a query.');

  const places = [];
  let pageToken;
  let requests = 0;

  while (places.length < maxResults && requests < 5) {
    requests++;
    const body = { textQuery: String(query).trim(), pageSize: Math.min(pageSize, maxResults - places.length) };
    if (pageToken) body.pageToken = pageToken;

    const res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': FIELDS.join(','),
      },
      body: JSON.stringify(body),
    });

    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw describeFailure(res.status, payload);

    // An empty `places` on the first page means the search found nothing; the
    // key and the mask were both fine, so say that rather than blaming them.
    const batch = Array.isArray(payload.places) ? payload.places : [];
    if (requests === 1 && batch.length === 0) {
      return { query, places: [], withoutWebsite: 0, searched: 0 };
    }
    places.push(...batch);

    pageToken = payload.nextPageToken;
    if (!pageToken || batch.length === 0) break;
  }

  const normalized = places.map(normalizePlace);

  // The field-mask trap: results arrive, every websiteUri is missing, and the
  // prospect list silently ends up empty. Name it instead.
  if (normalized.length > 0 && normalized.every((p) => p.name === '')) {
    throw new PlacesError(
      `Places returned ${normalized.length} results but none had a name, so the response shape is not what this expects.\n` +
        `  Asked for: ${FIELDS.join(', ')}\n` +
        `  Got keys: ${[...new Set(places.flatMap((p) => Object.keys(p)))].join(', ')}\n` +
        '  Correct the field names in prospects/places.mjs.',
    );
  }

  const withSite = normalized.filter((p) => p.website);
  return {
    query,
    places: withSite,
    withoutWebsite: normalized.length - withSite.length,
    searched: normalized.length,
  };
}

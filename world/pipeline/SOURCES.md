# Where the pipeline may fetch from, and why

The pipeline's HTTP client refuses any host not listed here as **allowed**, and checks each
host's `robots.txt` at run time before its first request. It also refuses a URL whose host
part is anything but a plain host name (user info, a port, a backslash, whitespace), so that
the host it checks is the host `requests` connects to. The robots.txt results below
were read on 25 Sept 2026 with the product token `CommonsWorld`.

## Robots policy

The rules follow RFC 9309, with one deliberate tightening:
- **2xx:** parse the file. Use the group for `commonsworld` if there is one, otherwise `*`.
  The longest matching rule wins; `allow` wins a tie; `*` and `$` are supported.
- **401 or 403:** treated as **disallow all**. RFC 9309 would allow everything here; this
  pipeline is stricter on purpose.
- **Other 4xx:** allow all (RFC 9309 "unavailable").
- **5xx or unreachable:** disallow all, and the build stops.
- **Redirects:** up to 5 are followed for robots.txt. Every redirect target of a data
  request is checked against its own host's robots.txt.

## Hosts

| Host | robots.txt (25 Sept 2026) | Status here | Used for | Licence of the data |
|---|---|---|---|---|
| `api.kartverket.no` | 404 | **allowed** | addresses (`/adresser/v1`), parcels (`/eiendom/v1`), place names (`/stedsnavn/v1`), municipality lookup (`/kommuneinfo/v1`) | CC BY 4.0, Kartverket |
| `hoydedata.no` | 404 | **allowed** | terrain and surface models (`/arcgis/rest/services/NHM_DTM_25832`, `NHM_DOM_25832`, `exportImage`) | CC BY 4.0, Kartverket |
| `wcs.geonorge.no` | 404 | **allowed** (fallback only) | the same height models via WCS | CC BY 4.0, Kartverket |
| `wfs.geonorge.no` | 404 | **allowed** | parcel register area (`wfs.matrikkelen-eiendomskart-teig`), building points (`wfs.matrikkelen-bygningspunkt`), trails (`wfs.turogfriluftsruter`) | CC BY 4.0, Kartverket |
| `nedlasting.geonorge.no` | 404 | **allowed** | download API per kommune: N50 Kartdata, NVDB Vegnett Pluss | CC BY 4.0, Kartverket |
| `kartkatalog.geonorge.no` | `User-agent: *` with no rules | **not on the allowlist** | nothing: no code looks licence metadata up | n/a |
| `api.met.no` | `User-agent: *` / `Disallow:` (empty) | **not on the allowlist** | nothing yet: a sunrise cross-check for the facts step, which is not written | MET Norway terms |
| `ws.geonorge.no` | **403** | **refused** | (address API; the same service is on `api.kartverket.no`) | n/a |
| `overpass-api.de` | **`Disallow: /api/`** | **refused** | (OpenStreetMap queries) | n/a |
| `re.jrc.ec.europa.eu` | **`Disallow: /`** | **refused** | (PVGIS horizon and irradiance) | n/a |
| `download.openstreetmap.fr` | **`Disallow: /*.pbf$`** | **refused** | (OpenStreetMap extracts) | n/a |
| `download.geofabrik.de` | `Disallow: *.osm.pbf` (read 24 Sept via another route; unreachable from here) | **refused** | (OpenStreetMap extracts) | n/a |
| `planet.openstreetmap.org` | only `User-agent: wget` allowed | **refused** | (OpenStreetMap planet) | n/a |

"Not on the allowlist" means robots.txt would let us in but no pipeline code uses the host,
so the client refuses it like any other. A step that needs one adds it here, to
`sources.ALLOWED_HOSTS` and to the tests together.

**Consequence: no OpenStreetMap data is fetched.** Norway is built entirely from
Kartverket's open data:
- **roads, footways, paths:** NVDB Vegnett Pluss, updated monthly;
- **land cover, water, coast:** N50 Kartdata;
- **buildings:** register points plus footprints segmented from the surface model;
- **trails:** Turrutebasen;
- **peaks:** place names plus terrain heights.

Because nothing is taken from OpenStreetMap, no ODbL share-alike obligation arises.

## Dataset identifiers (Geonorge)

| Dataset | Metadata UUID | Licence (catalogue record) |
|---|---|---|
| N50 Kartdata | `ea192681-d039-42ec-b1bc-f3ce04c189ac` | CC BY 4.0 |
| NVDB Vegnett Pluss | `97e6a869-8dd4-4379-bf39-f7d7dbf94863` | CC BY 4.0 (owner Kartverket; monthly) |
| Turrutebasen | `d1422d17-6d95-4ef1-96ab-8af31744dd63` | open, credit Kartverket |
| Stedsnavn (SSR) | `30caed2f-454e-44be-b5cc-26bb5c0110ca` | CC BY 4.0 |
| Matrikkelen eiendomskart teig | `74340c24-1c8a-4454-b813-bfe498e80f16` | CC BY 4.0 |

**Never requested:** Matrikkel owner data (restricted, and personal), FKB datasets
(restricted), and Norge i bilder orthophotos (restricted).

## Politeness

- One request at a time.
- At least 1 s between requests to the same host.
- Up to 4 retries on 429 or 5xx, with 2 / 4 / 8 / 16 s back-off, honouring `Retry-After`.
- An identifying User-Agent:
  `CommonsWorld/0.1 (+https://github.com/kaffeconway/Bergensers-commons)`.
- Every response is cached on disk (`world/pipeline/.cache/`, gitignored), so a rebuild
  does not refetch.

## Credits shown on screen

- **Kartverket:** "&#169; Kartverket", linked to kartverket.no, with a link to CC BY 4.0 and
  a note that the data was modified.
- **Place names:** "Alle stadnamn er henta fr&#229; SSR &#169;Kartverket" (the exact string
  is `sources.CREDIT_SSR`).

This file is kept pure ASCII: the two accented characters above are HTML character
references, which GitHub renders.

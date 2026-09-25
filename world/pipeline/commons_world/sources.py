"""Where the pipeline may fetch from, how it identifies itself, and whom it credits.

This module is the code form of world/pipeline/SOURCES.md. If the two disagree,
SOURCES.md is the statement of policy and this file is the bug. Change them
together.
"""

USER_AGENT = "CommonsWorld/0.1 (+https://github.com/kaffeconway/Bergensers-commons)"

# The product token matched against robots.txt user-agent lines (RFC 9309 s2.2.1).
ROBOTS_TOKEN = "CommonsWorld"

# Exactly the hosts SOURCES.md marks "allowed". Anything else is refused by the
# HTTP client before a request is made.
ALLOWED_HOSTS = frozenset({
    "api.kartverket.no",
    "hoydedata.no",
    "wcs.geonorge.no",
    "wfs.geonorge.no",
    "nedlasting.geonorge.no",
})

# Restrictions SOURCES.md puts on allowed hosts. The client does not enforce
# these; they are here so a reader of the code sees them.
HOST_NOTES = {
    "wcs.geonorge.no": "fallback only: the same height models as hoydedata.no",
}

# Hosts whose robots.txt would let us in, but which no pipeline code uses, so
# they are left off the allowlist. A later step that needs one adds it here,
# to ALLOWED_HOSTS and to SOURCES.md together.
NOT_ALLOWLISTED = {
    "kartkatalog.geonorge.no": "licence metadata; nothing looks it up",
    "api.met.no": "a sunrise cross-check for the facts step; not written yet",
}

# Hosts that were considered and refused, with the reason recorded in SOURCES.md
# (robots.txt read on 25 Sept 2026 with the token above).
REFUSED_HOSTS = {
    "ws.geonorge.no": "robots.txt answers 403, which this pipeline treats as disallow-all; "
                      "the same address API is on api.kartverket.no",
    "overpass-api.de": "robots.txt: Disallow: /api/ (OpenStreetMap queries)",
    "re.jrc.ec.europa.eu": "robots.txt: Disallow: / (PVGIS horizon and irradiance)",
    "download.openstreetmap.fr": "robots.txt: Disallow: /*.pbf$ (OpenStreetMap extracts)",
    "download.geofabrik.de": "robots.txt: Disallow: *.osm.pbf (OpenStreetMap extracts)",
    "planet.openstreetmap.org": "robots.txt allows only User-agent: wget (OpenStreetMap planet)",
}

# Geonorge metadata UUIDs, from SOURCES.md.
DATASETS = {
    "n50": {"name": "N50 Kartdata",
            "uuid": "ea192681-d039-42ec-b1bc-f3ce04c189ac",
            "licence": "CC BY 4.0"},
    "nvdb": {"name": "NVDB Vegnett Pluss",
             "uuid": "97e6a869-8dd4-4379-bf39-f7d7dbf94863",
             "licence": "CC BY 4.0"},
    "turrutebasen": {"name": "Turrutebasen",
                     "uuid": "d1422d17-6d95-4ef1-96ab-8af31744dd63",
                     "licence": "open, credit Kartverket"},
    "ssr": {"name": "Stedsnavn (SSR)",
            "uuid": "30caed2f-454e-44be-b5cc-26bb5c0110ca",
            "licence": "CC BY 4.0"},
    "teig": {"name": "Matrikkelen eiendomskart teig",
             "uuid": "74340c24-1c8a-4454-b813-bfe498e80f16",
             "licence": "CC BY 4.0"},
}

CC_BY_4 = "CC BY 4.0"
CC_BY_4_URL = "https://creativecommons.org/licenses/by/4.0/"

# Credit strings shown on screen and written into every world folder. The
# copyright sign and the a-ring are escaped so this file stays ASCII.
CREDIT_KARTVERKET = (
    "\u00a9 Kartverket (https://www.kartverket.no), CC BY 4.0 "
    "(https://creativecommons.org/licenses/by/4.0/). Modified: heights resampled, "
    "cut into chunks and rounded to 0.1 m; parcel boundaries moved into local "
    "metres."
)
CREDIT_SSR = "Alle stadnamn er henta fr\u00e5 SSR \u00a9Kartverket"

# Licence records for the manifest's "sources" list. The build adds
# "retrieved" from the dates the responses were actually fetched.
SOURCE_ADDRESS = {
    "name": "Adresse API (Matrikkelen, address points)",
    "publisher": "Kartverket",
    "licence": CC_BY_4,
    "licence_url": CC_BY_4_URL,
    "endpoint": "https://api.kartverket.no/adresser/v1/sok",
}
SOURCE_EIENDOM = {
    "name": "Eiendom API (parcel boundaries, geokoding with omrade=true)",
    "publisher": "Kartverket",
    "licence": CC_BY_4,
    "licence_url": CC_BY_4_URL,
    "endpoint": "https://api.kartverket.no/eiendom/v1/geokoding",
}
SOURCE_TEIG = {
    "name": "Matrikkelen eiendomskart teig (WFS; stored parcel area only)",
    "publisher": "Kartverket",
    "licence": CC_BY_4,
    "licence_url": CC_BY_4_URL,
    "endpoint": "https://wfs.geonorge.no/skwms1/wfs.matrikkelen-eiendomskart-teig",
    "dataset_uuid": DATASETS["teig"]["uuid"],
}
SOURCE_NHM_DTM = {
    "name": "Nasjonal h\u00f8ydemodell, terrain model (NHM DTM), via the hoydedata.no ImageServer",
    "publisher": "Kartverket",
    "licence": CC_BY_4,
    "licence_url": CC_BY_4_URL,
    "endpoint": "https://hoydedata.no/arcgis/rest/services/NHM_DTM_25832/ImageServer/exportImage",
    "note": "Kartverket's terms page puts its free products under CC BY 4.0; the DTM1 "
            "download feed states NLOD 2.0. Both require credit only.",
    "modified": "h1 read at native 1 m (nearest neighbour); h5 read at 2.5 m (bilinear, by "
                "the server) and averaged 2 x 2 into 5 m cells; h20 resampled by the server "
                "(bilinear); cut into chunks; rounded to 0.1 m; nodata set to 0 m.",
}
SOURCE_NHM_DOM = {
    "name": "Nasjonal h\u00f8ydemodell, surface model (NHM DOM), via the hoydedata.no ImageServer",
    "publisher": "Kartverket",
    "licence": CC_BY_4,
    "licence_url": CC_BY_4_URL,
    "endpoint": "https://hoydedata.no/arcgis/rest/services/NHM_DOM_25832/ImageServer/exportImage",
    "modified": "read at native 1 m (nearest neighbour) within the h1 radius; used for "
                "building footprints, roof heights and tree tops; roof planes are fitted to it "
                "and written into buildings.json; not written into the world as a raster.",
}

# Owner data is never requested. These services exist and are named here only
# so that nobody adds them by accident.
NEVER_REQUESTED = (
    "Matrikkel owner data (MatrikkelAPI, Matrikkelen WFS): restricted and personal",
    "FKB datasets: restricted to Norge digitalt parties",
    "Norge i bilder orthophotos: restricted",
)

# Map features (commons_world.features and its modules). No OpenStreetMap data.
SOURCE_KOMMUNEINFO = {
    "name": "Kommuneinfo API (which municipalities the world touches; lookups only)",
    "publisher": "Kartverket",
    "licence": CC_BY_4,
    "licence_url": CC_BY_4_URL,
    "endpoint": "https://api.kartverket.no/kommuneinfo/v1",
}
SOURCE_N50 = {
    "name": "N50 Kartdata (land cover, water, paths and tracks, spot heights), per municipality",
    "publisher": "Kartverket",
    "licence": CC_BY_4,
    "licence_url": CC_BY_4_URL,
    "endpoint": "https://nedlasting.geonorge.no/api/order",
    "dataset_uuid": DATASETS["n50"]["uuid"],
    "modified": "land-cover polygons, lakes, rivers, paths and tracks rasterised into the "
                "height chunks' class band; other N50 content not used.",
}
SOURCE_NVDB = {
    "name": "NVDB Vegnett Pluss (road, footway and cycleway centre lines), per municipality",
    "publisher": "Kartverket (data owner Statens vegvesen)",
    "licence": CC_BY_4,
    "licence_url": CC_BY_4_URL,
    "endpoint": "https://nedlasting.geonorge.no/api/order",
    "dataset_uuid": DATASETS["nvdb"]["uuid"],
    "modified": "reprojected from EUREF89 UTM 33 to the world's grid; heights dropped; "
                "buffered to nominal widths and rasterised into the class band.",
}
SOURCE_TURRUTER = {
    "name": "Turrutebasen (foot routes and route information points), WFS",
    "publisher": "Kartverket",
    "licence": DATASETS["turrutebasen"]["licence"],
    "endpoint": "https://wfs.geonorge.no/skwms1/wfs.turogfriluftsruter",
    "dataset_uuid": DATASETS["turrutebasen"]["uuid"],
    "note": "The catalogue record says open data with no conditions; Kartverket's terms "
            "ask for credit, which is given.",
}
SOURCE_BYGNINGSPUNKT = {
    "name": "Matrikkelen bygningspunkt (building type, number, status and point only), WFS",
    "publisher": "Kartverket",
    "licence": CC_BY_4,
    "licence_url": CC_BY_4_URL,
    "endpoint": "https://wfs.geonorge.no/skwms1/wfs.matrikkelen-bygningspunkt",
    "modified": "used only to anchor footprints segmented from the surface model; building "
                "numbers and status are not written into the world.",
}
SOURCE_STEDSNAVN = {
    "name": "Stedsnavn API (SSR place names: terrain features only)",
    "publisher": "Kartverket",
    "licence": DATASETS["ssr"]["licence"],
    "licence_url": CC_BY_4_URL,
    "endpoint": "https://api.kartverket.no/stedsnavn/v1/punkt",
    "dataset_uuid": DATASETS["ssr"]["uuid"],
    "modified": "heights sampled from the terrain model, not from the register.",
}
CREDIT_KARTVERKET_MAP = (
    "\u00a9 Kartverket (https://www.kartverket.no), CC BY 4.0: N50 Kartdata, NVDB Vegnett "
    "Pluss, Turrutebasen, Matrikkelen building points and the surface model. Modified: land "
    "cover, water, roads and paths rasterised into classes; building footprints and trees "
    "derived from the surface model."
)

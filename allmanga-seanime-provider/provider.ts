/// <reference path="./onlinestream-provider.d.ts" />

/**
 * Seanime Online Streaming Provider — ani-cli / allmanga
 *
 * Direct port of ani-cli v4.8+ scraping logic to Seanime's ES5 JS engine.
 * Source: https://github.com/pystardust/ani-cli
 * Backend: https://api.allanime.day
 */

// ─── Constants (from ani-cli source) ─────────────────────────────────────────

var ALLANIME_API  = "https://api.allanime.day/api";
var ALLANIME_BASE = "allanime.day";
var ALLANIME_REFR = "https://allanime.to";
var AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0";

// ─── GraphQL queries (verbatim from ani-cli) ──────────────────────────────────

var SEARCH_GQL = "query( $search: SearchInput $limit: Int $page: Int $translationType: VaildTranslationTypeEnumType $countryOrigin: VaildCountryOriginEnumType ) { shows( search: $search limit: $limit page: $page translationType: $translationType countryOrigin: $countryOrigin ) { edges { _id name availableEpisodes __typename } }}";

var EPISODES_GQL = "query ($showId: String!) { show( _id: $showId ) { _id availableEpisodesDetail }}";

var EPISODE_EMBED_GQL = "query ($showId: String!, $translationType: VaildTranslationTypeEnumType!, $episodeString: String!) { episode( showId: $showId translationType: $translationType episodeString: $episodeString ) { episodeString sourceUrls }}";

// ─── Decode table (from ani-cli provider_init sed chain) ─────────────────────
// ani-cli splits each encoded char into 2-char hex pairs and maps them to URL chars.

var HEX_MAP = {
    "01": "9", "08": "0", "05": "=", "0a": "2", "0b": "3", "0c": "4",
    "07": "?", "00": "8", "5c": "d", "0f": "7", "5e": "f", "17": "/",
    "54": "l", "09": "1", "48": "p", "4f": "w", "0e": "6", "5b": "c",
    "5d": "e", "0d": "5", "53": "k", "1e": "&", "5a": "b", "59": "a",
    "4a": "r", "4c": "t", "4e": "v", "57": "o", "51": "i"
};

/**
 * Decode a provider_id from the sourceUrl "-- prefix" value.
 * ani-cli does: split into 2-char groups → lookup table → join → replace /clock with /clock.json
 */
function decodeProviderId(encoded) {
    var result = "";
    for (var i = 0; i < encoded.length; i += 2) {
        var pair = encoded.substr(i, 2).toLowerCase();
        if (HEX_MAP[pair] !== undefined) {
            result += HEX_MAP[pair];
        } else {
            // pass-through unmapped chars (letters, digits not in table)
            result += encoded.charAt(i);
            if (i + 1 < encoded.length) result += encoded.charAt(i + 1);
        }
    }
    return result.replace("/clock", "/clock.json");
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function apiGet(queryStr, variables) {
    var body = JSON.stringify({ query: queryStr, variables: variables });
    var res = fetch(ALLANIME_API, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "User-Agent": AGENT,
            "Referer": ALLANIME_REFR + "/",
            "Origin": ALLANIME_REFR
        },
        body: body
    });
    return res.json();
}

function embedGet(path) {
    var url = "https://" + ALLANIME_BASE + path;
    var res = fetch(url, {
        headers: {
            "User-Agent": AGENT,
            "Referer": ALLANIME_REFR + "/"
        }
    });
    return res.text();
}

// ─── Link extractor (mirrors ani-cli get_links) ───────────────────────────────

/**
 * Given a /clock.json path, fetch the JSON and return video links
 * shaped as [{ quality, url }].
 *
 * The clock endpoint returns either:
 *   { links: [{ link, resolutionStr }] }          (wixmp / vipanicdn / anifastcdn)
 *   { hls: { url }, ... }                          (HLS direct)
 */
function getLinksFromClockPath(clockPath) {
    try {
        var raw = embedGet(clockPath);
        var data = JSON.parse(raw);
        var links = [];

        // Case 1: links array (wixmp style)
        if (data.links && Array.isArray(data.links)) {
            for (var i = 0; i < data.links.length; i++) {
                var item = data.links[i];
                var url = item.link || item.src || "";
                var quality = item.resolutionStr || item.resolution || "auto";

                // wixmp repackager pattern: strip repackager, expand qualities from URL
                if (url.indexOf("repackager.wixmp.com") !== -1) {
                    url = url.replace(/repackager\.wixmp\.com\//g, "")
                             .replace(/\.urlset.*/, "");
                    links.push({ url: url, quality: quality });
                } else if (url) {
                    links.push({ url: url, quality: quality });
                }
            }
        }

        // Case 2: hls url with hardsub_lang en-US
        if (data.hls && data.hls.url) {
            links.push({ url: data.hls.url, quality: "auto" });
        }

        // Case 3: single mp4 url field
        if (data.url && !links.length) {
            links.push({ url: data.url, quality: "auto" });
        }

        return links;
    } catch (e) {
        return [];
    }
}

// ─── Provider name → sourceUrl pattern (from ani-cli generate_link / provider_init) ─

// ani-cli maps provider numbers to sed patterns that match sourceName in the resp:
//  1 → "Default"  (wixmp)
//  2 → "Sak"      (dropbox)
//  3 → "Kir"      (wetransfer)
//  4 → "S-mp4"    (sharepoint)
//  * → "Luf-mp4"  (gogoanime)

var PROVIDER_PATTERNS = ["Default", "Sak", "Kir", "S-mp4", "Luf-mp4"];

// ─── Parse sourceUrls from episode GQL response ───────────────────────────────

/**
 * The raw response has sourceUrls like:
 *   { sourceUrl: "--<encoded>", sourceName: "Default", ... }
 * ani-cli strips the "--" prefix and runs provider_init decode.
 */
function parseSourceUrls(episode) {
    if (!episode || !episode.sourceUrls) return [];

    var sources = [];
    var raw = episode.sourceUrls;

    for (var i = 0; i < raw.length; i++) {
        var src = raw[i];
        var sourceUrl  = src.sourceUrl  || "";
        var sourceName = src.sourceName || "";

        if (sourceUrl.indexOf("--") === 0) {
            var encoded = sourceUrl.slice(2);
            var clockPath = decodeProviderId(encoded);
            if (clockPath) {
                sources.push({ name: sourceName, clockPath: clockPath });
            }
        }
    }
    return sources;
}

// ─── Provider Class ───────────────────────────────────────────────────────────

class Provider {

    getSettings() {
        return {
            // Servers listed in order of ani-cli priority (wixmp first)
            episodeServers: ["wixmp", "dropbox", "wetransfer", "sharepoint", "gogoanime"],
            supportsAdult: false
        };
    }

    // ── Search ──────────────────────────────────────────────────────────────

    search(opts) {
        var query = (opts.query || "").replace(/ /g, "+");
        var dub   = opts.dub || false;
        var mode  = dub ? "dub" : "sub";

        try {
            var data = apiGet(SEARCH_GQL, {
                search: {
                    allowAdult: false,
                    allowUnknown: false,
                    query: query
                },
                limit: 40,
                page: 1,
                translationType: mode,
                countryOrigin: "ALL"
            });

            var edges = (data.data && data.data.shows && data.data.shows.edges) || [];
            var results = [];

            for (var i = 0; i < edges.length; i++) {
                var e = edges[i];
                var epCount = 0;
                if (e.availableEpisodes && typeof e.availableEpisodes === "object") {
                    epCount = e.availableEpisodes[mode] || 0;
                }
                // ani-cli only shows results that have at least 1 episode in requested mode
                if (epCount > 0) {
                    results.push({
                        id:    e._id,
                        title: e.name || "",
                        image: ""
                    });
                }
            }
            return results;
        } catch (e) {
            return [];
        }
    }

    // ── Episode List ─────────────────────────────────────────────────────────

    getEpisodes(opts) {
        var showId = opts.id;
        var dub    = opts.dub || false;
        var mode   = dub ? "dub" : "sub";

        try {
            var data = apiGet(EPISODES_GQL, { showId: showId });
            var show = data.data && data.data.show;
            if (!show) return [];

            var detail = show.availableEpisodesDetail || {};
            var epArr  = detail[mode] || [];

            // Sort numerically (same as ani-cli `sort -n`)
            epArr = epArr.slice().sort(function (a, b) {
                return parseFloat(a) - parseFloat(b);
            });

            var episodes = [];
            for (var i = 0; i < epArr.length; i++) {
                var num = epArr[i];
                episodes.push({
                    id:     showId + "|||" + mode + "|||" + num,
                    number: parseFloat(num),
                    title:  "Episode " + num
                });
            }
            return episodes;
        } catch (e) {
            return [];
        }
    }

    // ── Video Sources ────────────────────────────────────────────────────────

    getVideoSource(opts) {
        var parts = (opts.episodeId || "").split("|||");
        if (parts.length < 3) return { sources: [] };

        var showId    = parts[0];
        var mode      = parts[1];
        var epNo      = parts[2];

        // server preference: which provider name to prefer
        var serverPref = opts.server || "wixmp";

        try {
            var data = apiGet(EPISODE_EMBED_GQL, {
                showId: showId,
                translationType: mode,
                episodeString: epNo
            });

            var episode = data.data && data.data.episode;
            var decoded = parseSourceUrls(episode);

            if (!decoded.length) return { sources: [] };

            // Sort providers: preferred server first, then in ani-cli order
            var ordered = decoded.slice().sort(function (a, b) {
                var ai = PROVIDER_PATTERNS.indexOf(a.name);
                var bi = PROVIDER_PATTERNS.indexOf(b.name);
                // preferred server always first
                if (a.name.toLowerCase() === serverPref) return -1;
                if (b.name.toLowerCase() === serverPref) return 1;
                if (ai === -1) ai = 99;
                if (bi === -1) bi = 99;
                return ai - bi;
            });

            var sources = [];

            for (var i = 0; i < ordered.length; i++) {
                var provider = ordered[i];
                var links = getLinksFromClockPath(provider.clockPath);

                for (var j = 0; j < links.length; j++) {
                    var link = links[j];
                    if (!link.url) continue;

                    var isHls = link.url.indexOf(".m3u8") !== -1 ||
                                link.url.indexOf("m3u8")  !== -1;

                    sources.push({
                        url:     link.url,
                        quality: String(link.quality || "auto"),
                        type:    isHls ? "hls" : "mp4"
                    });
                }

                // Once we have sources from the preferred provider, stop
                if (sources.length > 0 && i === 0) break;
            }

            // Sort sources: highest resolution first (same as ani-cli `sort -g -r`)
            sources.sort(function (a, b) {
                var qa = parseInt(a.quality) || 0;
                var qb = parseInt(b.quality) || 0;
                return qb - qa;
            });

            return { sources: sources };
        } catch (e) {
            return { sources: [] };
        }
    }
}

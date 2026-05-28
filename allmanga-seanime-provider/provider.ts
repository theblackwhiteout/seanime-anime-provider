/// <reference path="./onlinestream-provider.d.ts" />

/**
 * Seanime Online Streaming Provider — ani-cli (allmanga.to)
 *
 * Replicates the scraping logic from ani-cli to feed episode lists
 * and HLS/video sources into Seanime's online streaming system.
 *
 * Source site : https://allmanga.to  (same as ani-cli)
 * Provider ID : ani-cli-provider
 */

var BASE_URL = "https://allanime.day";
var API_URL  = BASE_URL + "/api";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rot13(str) {
    return str.replace(/[a-zA-Z]/g, function (c) {
        var base = c <= 'Z' ? 65 : 97;
        return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
    });
}

function decodeAnilistSource(encoded) {
    // ani-cli decodes the source URL by applying ROT13 then decoding from hex
    try {
        var rotated = rot13(encoded);
        // hex decode
        var hex = rotated.replace(/\\x/g, '');
        var result = '';
        for (var i = 0; i < hex.length; i += 2) {
            result += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
        }
        return result;
    } catch (e) {
        return encoded;
    }
}

function gqlFetch(query, variables) {
    var body = JSON.stringify({ query: query, variables: variables });
    var res = fetch(API_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (compatible; Seanime)",
            "Referer": "https://allmanga.to"
        },
        body: body
    });
    return res.json();
}

// ─── GraphQL Queries (same logic as ani-cli) ─────────────────────────────────

var SEARCH_QUERY = "\n    query ($search: SearchInput, $limit: Int, $page: Int, $translationType: VaildTranslationTypeEnumType) {\n        shows(\n            search: $search\n            limit: $limit\n            page: $page\n            translationType: $translationType\n        ) {\n            edges {\n                _id\n                name\n                englishName\n                nativeName\n                thumbnail\n                score\n                type\n                season { quarter year }\n                availableEpisodes { sub dub raw }\n            }\n        }\n    }\n";

var EPISODES_QUERY = "\n    query ($showId: String!, $translationType: VaildTranslationTypeEnumType!, $episodeNumStart: Float, $episodeNumEnd: Float) {\n        show(_id: $showId) {\n            _id\n            name\n            availableEpisodesDetail\n        }\n        episodeInfos(\n            showId: $showId\n            translationType: $translationType\n            episodeNumStart: $episodeNumStart\n            episodeNumEnd: $episodeNumEnd\n        ) {\n            episodeIdNum\n            notes\n            vidInforssub { vidResolution vidPath }\n            vidInforsdub { vidResolution vidPath }\n        }\n    }\n";

var SOURCES_QUERY = "\n    query ($showId: String!, $translationType: VaildTranslationTypeEnumType!, $episodeString: String!) {\n        episode(\n            showId: $showId\n            translationType: $translationType\n            episodeString: $episodeString\n        ) {\n            episodeString\n            sourceUrls\n        }\n    }\n";

// ─── Provider Class ───────────────────────────────────────────────────────────

class Provider {

    getSettings() {
        return {
            episodeServers: ["default", "sharepoint", "mp4upload"],
            supportsAdult: false
        };
    }

    // ── Search ──────────────────────────────────────────────────────────────

    search(opts) {
        /**
         * opts.query  : string  – the anime title
         * opts.dub    : boolean – true if user wants dubbed
         */
        var query = opts.query;
        var dub   = opts.dub || false;

        try {
            var translationType = dub ? "dub" : "sub";
            var data = gqlFetch(SEARCH_QUERY, {
                search: {
                    allowAdult: false,
                    allowUnknown: false,
                    query: query
                },
                limit: 20,
                page: 1,
                translationType: translationType
            });

            var edges = (data.data && data.data.shows && data.data.shows.edges) || [];

            return edges.map(function (show) {
                return {
                    id: show._id,
                    title: show.englishName || show.name || show.nativeName || "",
                    image: show.thumbnail || "",
                    year: show.season ? show.season.year : null
                };
            });
        } catch (e) {
            return [];
        }
    }

    // ── Episode List ─────────────────────────────────────────────────────────

    getEpisodes(opts) {
        /**
         * opts.id  : string  – the show _id from search
         * opts.dub : boolean – dubbed flag
         */
        var showId = opts.id;
        var dub    = opts.dub || false;
        var translationType = dub ? "dub" : "sub";

        try {
            var data = gqlFetch(EPISODES_QUERY, {
                showId: showId,
                translationType: translationType,
                episodeNumStart: 0,
                episodeNumEnd: 9999
            });

            var infos = (data.data && data.data.episodeInfos) || [];

            if (!infos.length) {
                // Fallback: derive episode list from availableEpisodesDetail
                var show = data.data && data.data.show;
                var detail = (show && show.availableEpisodesDetail) || {};
                var epList = detail[translationType] || detail["sub"] || [];
                return epList.map(function (epNum) {
                    return {
                        id: showId + "___" + translationType + "___" + epNum,
                        number: parseFloat(epNum),
                        title: "Episode " + epNum
                    };
                });
            }

            return infos.map(function (ep) {
                return {
                    id: showId + "___" + translationType + "___" + ep.episodeIdNum,
                    number: parseFloat(ep.episodeIdNum),
                    title: ep.notes ? ("Episode " + ep.episodeIdNum + " – " + ep.notes) : ("Episode " + ep.episodeIdNum)
                };
            });
        } catch (e) {
            return [];
        }
    }

    // ── Video Sources ────────────────────────────────────────────────────────

    getVideoSource(opts) {
        /**
         * opts.episodeId : string – from getEpisodes
         * opts.server    : string – "default", "sharepoint", "mp4upload"
         */
        var episodeId = opts.episodeId;
        var parts = episodeId.split("___");

        if (parts.length < 3) {
            return { sources: [] };
        }

        var showId          = parts[0];
        var translationType = parts[1];
        var episodeString   = parts[2];

        try {
            var data = gqlFetch(SOURCES_QUERY, {
                showId: showId,
                translationType: translationType,
                episodeString: episodeString
            });

            var episode = data.data && data.data.episode;
            if (!episode || !episode.sourceUrls) {
                return { sources: [] };
            }

            var sourceUrls = episode.sourceUrls;
            var sources = [];

            for (var i = 0; i < sourceUrls.length; i++) {
                var src = sourceUrls[i];
                // sourceUrls are objects with { sourceUrl, priority, sourceName, type }
                var rawUrl  = src.sourceUrl || "";
                var srcName = (src.sourceName || "").toLowerCase();
                var type    = src.type || "";

                // Skip sources that need further resolution we can't do in ES5
                if (!rawUrl) continue;

                // ani-cli-style decode: URLs starting with "--" are encoded
                var url = rawUrl;
                if (rawUrl.indexOf("--") === 0) {
                    url = decodeAnilistSource(rawUrl.slice(2));
                }

                // Only include HLS or mp4 streams
                if (url.indexOf("m3u8") !== -1 || url.indexOf(".mp4") !== -1 ||
                    type === "player" || type === "iframe") {

                    var quality = "auto";
                    if (src.priority) {
                        quality = "" + Math.round(src.priority * 1080) + "p";
                    }

                    sources.push({
                        url: url,
                        quality: quality,
                        type: url.indexOf("m3u8") !== -1 ? "hls" : "mp4"
                    });
                }
            }

            // Sort by priority (higher = better quality in allmanga's scheme)
            sources.sort(function (a, b) {
                var pa = parseFloat(a.quality) || 0;
                var pb = parseFloat(b.quality) || 0;
                return pb - pa;
            });

            return { sources: sources };
        } catch (e) {
            return { sources: [] };
        }
    }
}

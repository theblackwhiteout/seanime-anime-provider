/// <reference path="./onlinestream-provider.d.ts" />

// ---------------------------------------------------------------------------
// AllManga (allmanga.to) — Seanime Online Streaming Provider
// ---------------------------------------------------------------------------

const BASE     = "https://allmanga.to";
const API_HOST = "https://api.allanime.day";
const REFERER  = "https://allmanga.to/";
const AGENT    = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0";

// Byte-to-character map used by AllManga's URL obfuscation
const DECODE_MAP: Record<string, string> = {
    "79":"A","7a":"B","7b":"C","7c":"D","7d":"E","7e":"F","7f":"G","70":"H",
    "71":"I","72":"J","73":"K","74":"L","75":"M","76":"N","77":"O","68":"P",
    "69":"Q","6a":"R","6b":"S","6c":"T","6d":"U","6e":"V","6f":"W","60":"X",
    "61":"Y","62":"Z","59":"a","5a":"b","5b":"c","5c":"d","5d":"e","5e":"f",
    "5f":"g","50":"h","51":"i","52":"j","53":"k","54":"l","55":"m","56":"n",
    "57":"o","48":"p","49":"q","4a":"r","4b":"s","4c":"t","4d":"u","4e":"v",
    "4f":"w","40":"x","41":"y","42":"z","08":"0","09":"1","0a":"2","0b":"3",
    "0c":"4","0d":"5","0e":"6","0f":"7","00":"8","01":"9","15":"-","16":".",
    "67":"_","46":"~","02":":","17":"/","07":"?","1b":"#","63":"[","65":"]",
    "78":"@","19":"!","1c":"$","1e":"&","10":"(","11":")","12":"*","13":"+",
    "14":",","03":";","05":"=","1d":"%",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decodeUrl(encoded: string): string {
    let out = "";
    for (let i = 0; i < encoded.length; i += 2) {
        const byte = encoded.substring(i, i + 2);
        out += DECODE_MAP[byte] ?? "";
    }
    // AllManga clock endpoints need a .json suffix
    return out.replace(/\/clock/g, "/clock.json");
}

async function gqlRequest(query: string, variables: Record<string, any>): Promise<any> {
    const res = await fetch(`${API_HOST}/api`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Referer": REFERER,
            "User-Agent": AGENT,
        },
        body: JSON.stringify({ variables, query }),
    });
    if (!res.ok) throw new Error(`GQL request failed: ${res.status}`);
    return res.json();
}

async function resolveSource(source: any, server: string): Promise<EpisodeServer> {
    let rawUrl: string = source.sourceUrl ?? "";
    const sourceName: string = source.sourceName ?? "";

    if (rawUrl.startsWith("--")) {
        rawUrl = decodeUrl(rawUrl.slice(2));
    }

    const absoluteUrl = rawUrl.startsWith("http")
        ? rawUrl
        : `${BASE}${rawUrl.startsWith("/") ? rawUrl : "/" + rawUrl}`;

    try {
        const res = await fetch(absoluteUrl, {
            headers: { "Referer": REFERER, "User-Agent": AGENT },
        });
        if (!res.ok) throw new Error(`Clock API returned ${res.status}`);
        const json = await res.json();

        if (!json.links || !Array.isArray(json.links)) {
            throw new Error("Response missing 'links' array");
        }

        const videoSources: VideoSource[] = json.links.map((link: any) => ({
            url:       link.link,
            quality:   link.resolutionStr ?? "auto",
            type:      link.link?.includes(".m3u8") ? "m3u8" : "mp4",
            subtitles: [],
        }));

        return { server, videoSources, headers: {} };
    } catch (e: any) {
        console.error(`[AllManga] Resolution error for ${sourceName}: ${e.message}`);
        return { server, videoSources: [], headers: {} };
    }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

class Provider {

    getSettings(): Settings {
        return {
            episodeServers: ["wixmp", "S-mp4", "Luf-Mp4", "Mp4", "Default"],
            supportsDub: true,
        };
    }

    // Seanime calls this with { query: string, dub: boolean }
    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const translationType = opts.dub ? "dub" : "sub";

        const gql = `
            query($search:SearchInput $limit:Int $page:Int $translationType:VaildTranslationTypeEnumType){
                shows(search:$search limit:$limit page:$page translationType:$translationType){
                    edges{ _id name availableEpisodes }
                }
            }
        `;

        const data = await gqlRequest(gql, {
            search: { query: opts.query, allowAdult: false, allowUnknown: false },
            limit: 20,
            page: 1,
            translationType,
        });

        const edges: any[] = data?.data?.shows?.edges ?? [];

        return edges.map(s => ({
            id:       `${s._id}|||${translationType}`,
            title:    s.name,
            url:      `${BASE}/bangumi/${s._id}`,
            subOrDub: translationType as SubOrDub,
        }));
    }

    // id format: "showId|||lang"
    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const [showId, language] = id.split("|||");
        const lang = language === "dub" ? "dub" : "sub";

        const gql = `query($showId:String!){ show(_id:$showId){ _id availableEpisodesDetail } }`;
        const data = await gqlRequest(gql, { showId });

        const detail = data?.data?.show?.availableEpisodesDetail;
        const eps: string[] = lang === "dub" ? (detail?.dub ?? []) : (detail?.sub ?? []);

        return eps
            .map(e => ({
                id:     `${showId}|||${lang}|||${e}`,
                title:  `Episode ${e}`,
                number: parseFloat(e),
                url:    `${BASE}/bangumi/${showId}/episodes/${e}`,
            }))
            .sort((a, b) => a.number - b.number);
    }

    // episode.id format: "showId|||lang|||episodeString"
    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        const parts = episode.id.split("|||");
        if (parts.length !== 3) throw new Error(`Invalid episode ID format: ${episode.id}`);

        const [showId, translationType, episodeString] = parts;

        const gql = `
            query($showId:String! $translationType:VaildTranslationTypeEnumType! $episodeString:String!){
                episode(showId:$showId translationType:$translationType episodeString:$episodeString){ sourceUrls }
            }
        `;

        const data = await gqlRequest(gql, { showId, translationType, episodeString });
        const sources: any[] = data?.data?.episode?.sourceUrls ?? [];

        if (sources.length === 0) throw new Error(`No sources found for episode ${episodeString}`);

        const priority = ["wixmp", "S-mp4", "Luf-Mp4", "Mp4", "Default"];

        // Prefer the explicitly requested server, then fall back by priority
        let selected = sources.find(s => s.sourceName?.toLowerCase() === server.toLowerCase());
        if (!selected) {
            for (const name of priority) {
                selected = sources.find(s => s.sourceName?.toLowerCase() === name.toLowerCase());
                if (selected) break;
            }
        }

        return resolveSource(selected ?? sources[0], server);
    }
}

/// <reference path="./online-streaming-provider.d.ts" />
/// <reference path="./core.d.ts" />

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

// Resolve a single sourceUrl entry into a list of VideoSources.
// Handles three cases:
//   1. wixmp repackager URLs  → parse quality variants out of the CDN path
//   2. tools.fast4speed.rsvp  → direct stream, use as-is at 1080p
//   3. Everything else        → fetch the clock.json, read links[], parse m3u8 playlist
async function resolveSource(source: any): Promise<VideoSource[]> {
    let rawUrl: string = source.sourceUrl ?? "";

    if (!rawUrl) {
        console.warn("[AllManga] No sourceUrl provided");
        return [];
    }

    // Strip leading "--" and decode the obfuscated path
    if (rawUrl.startsWith("--")) {
        rawUrl = decodeUrl(rawUrl.slice(2));
    }

    // Build absolute URL
    const absoluteUrl = rawUrl.startsWith("http")
        ? rawUrl
        : `${BASE}${rawUrl.startsWith("/") ? rawUrl : "/" + rawUrl}`;

    console.log(`[AllManga] Resolving source: ${absoluteUrl.substring(0, 50)}...`);

    // --- Case 2: fast4speed direct stream ---
    if (absoluteUrl.includes("tools.fast4speed.rsvp")) {
        console.log("[AllManga] Detected fast4speed stream");
        return [{
            url: absoluteUrl,
            quality: "1080p",
            type: "m3u8",
            subtitles: [],
        }];
    }

    // Fetch the clock.json endpoint
    let clockJson: any;
    try {
        console.log(`[AllManga] Fetching clock endpoint...`);
        const res = await fetch(absoluteUrl, {
            headers: { 
                "Referer": REFERER, 
                "User-Agent": AGENT,
                "Accept": "application/json",
            },
        });
        
        if (!res.ok) {
            throw new Error(`Clock fetch failed with status ${res.status}`);
        }
        
        const responseText = await res.text();
        
        // Try to parse JSON
        try {
            clockJson = JSON.parse(responseText);
        } catch (parseError) {
            console.error(`[AllManga] Failed to parse clock response as JSON`);
            console.error(`[AllManga] Response preview: ${responseText.substring(0, 200)}`);
            return [];
        }
        
    } catch (e: any) {
        console.error(`[AllManga] Clock fetch error: ${e.message}`);
        console.error(`[AllManga] Attempted URL: ${absoluteUrl}`);
        return [];
    }

    if (!clockJson) {
        console.warn("[AllManga] Empty clock response");
        return [];
    }

    const links: any[] = clockJson?.links ?? [];
    
    if (links.length === 0) {
        console.warn("[AllManga] No links found in clock response");
        return [];
    }

    console.log(`[AllManga] Found ${links.length} link(s) in clock response`);

    const videoSources: VideoSource[] = [];

    for (const linkObj of links) {
        const link: string = linkObj.link ?? "";
        
        if (!link) {
            console.warn("[AllManga] Link object missing 'link' field");
            continue;
        }
        
        const referer: string = linkObj.headers?.Referer ?? REFERER;

        // --- Case 1: wixmp repackager ---
        // URL format: https://repackager.wixmp.com/<base>,360p,480p,720p,1080p,<suffix>.urlset/...
        if (link.includes("repackager.wixmp.com")) {
            console.log("[AllManga] Detected wixmp repackager stream");
            try {
                const stripped = link.split(".urlset")[0].replace("repackager.wixmp.com/", "");
                const parts = stripped.split(",");
                const base = parts[0];
                const suffix = parts[parts.length - 1];
                const qualities = parts.slice(1, -1); // e.g. ["360p","480p","720p","1080p"]
                
                for (const q of qualities) {
                    videoSources.push({
                        url: base + q + suffix,
                        quality: q,
                        type: "m3u8",
                        subtitles: [],
                    });
                }
            } catch (e: any) {
                console.error(`[AllManga] Failed to parse wixmp URL: ${e.message}`);
            }
            continue;
        }

        // --- Case 3: standard m3u8 playlist ---
        // Fetch the playlist to enumerate quality variants
        try {
            console.log("[AllManga] Fetching m3u8 playlist...");
            const playlistRes = await fetch(link, {
                headers: { 
                    "Referer": referer, 
                    "User-Agent": AGENT,
                    "Accept": "*/*",
                },
            });
            
            if (!playlistRes.ok) {
                throw new Error(`Playlist fetch failed with status ${playlistRes.status}`);
            }
            
            const playlistText = await playlistRes.text();

            if (!playlistText || playlistText.length === 0) {
                console.warn("[AllManga] Empty playlist response");
                videoSources.push({
                    url: link,
                    quality: linkObj.resolutionStr ?? "auto",
                    type: "m3u8",
                    subtitles: [],
                });
                continue;
            }

            // Extract resolution + URI pairs from the m3u8
            const streamRegex = /#EXT-X-STREAM-INF:[^\n]*RESOLUTION=\d+x(\d+)[^\n]*\n([^\n]+)/g;
            let match: RegExpExecArray | null;
            let foundVariants = false;

            const baseUri = link.substring(0, link.lastIndexOf("/") + 1);

            while ((match = streamRegex.exec(playlistText)) !== null) {
                foundVariants = true;
                const height = match[1];
                const uri = match[2].trim();
                const variantUrl = uri.startsWith("http") ? uri : baseUri + uri;
                videoSources.push({
                    url: variantUrl,
                    quality: `${height}p`,
                    type: "m3u8",
                    subtitles: [],
                });
            }

            // If there were no variant streams it's already the direct stream
            if (!foundVariants) {
                console.log("[AllManga] No m3u8 variants found, using as direct stream");
                videoSources.push({
                    url: link,
                    quality: linkObj.resolutionStr ?? "auto",
                    type: "m3u8",
                    subtitles: [],
                });
            } else {
                console.log(`[AllManga] Found ${foundVariants ? videoSources.length : 0} quality variants`);
            }
        } catch (e: any) {
            console.error(`[AllManga] Playlist parse error: ${e.message}`);
            console.error(`[AllManga] Playlist URL: ${link}`);
            // Fall back to the raw link
            videoSources.push({
                url: link,
                quality: linkObj.resolutionStr ?? "auto",
                type: link.includes(".m3u8") ? "m3u8" : "mp4",
                subtitles: [],
            });
        }
    }

    if (videoSources.length === 0) {
        console.warn("[AllManga] No video sources could be resolved");
    } else {
        console.log(`[AllManga] Successfully resolved ${videoSources.length} video source(s)`);
    }

    return videoSources;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

class Provider {

    getSettings(): Settings {
        return {
            // Ordered by preference; Seanime will try them in this order
            episodeServers: ["Luf-Mp4", "S-Mp4", "Yt-mp4", "Default"],
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
        if (parts.length !== 3) throw new Error(`Invalid episode ID: ${episode.id}`);

        const [showId, translationType, episodeString] = parts;

        const gql = `
            query($showId:String! $translationType:VaildTranslationTypeEnumType! $episodeString:String!){
                episode(showId:$showId translationType:$translationType episodeString:$episodeString){
                    sourceUrls
                }
            }
        `;

        const data = await gqlRequest(gql, { showId, translationType, episodeString });

        // AllManga sometimes wraps the episode data in an encrypted "tobeparsed" field.
        // We can't decrypt AES-GCM in Seanime's JS engine (no crypto APIs), so we
        // fall back to the plain sourceUrls path when tobeparsed is present.
        const episodeData = data?.data?.tobeparsed
            ? data?.data?.episode  // tobeparsed present but we use episode directly as fallback
            : data?.data?.episode;

        const sources: any[] = episodeData?.sourceUrls ?? [];
        if (sources.length === 0) throw new Error(`No sources for episode ${episodeString}`);

        // Preferred server names in priority order
        const priority = ["Luf-Mp4", "S-Mp4", "Yt-mp4", "Default"];

        // Try the requested server first, then fall back through the priority list
        let selected = sources.find(s =>
            s.sourceName?.toLowerCase() === server.toLowerCase()
        );
        if (!selected) {
            for (const name of priority) {
                selected = sources.find(s =>
                    s.sourceName?.toLowerCase() === name.toLowerCase()
                );
                if (selected) break;
            }
        }
        if (!selected) selected = sources[0];

        console.log(`[AllManga] Using source: ${selected.sourceName}`);

        const videoSources = await resolveSource(selected);

        if (videoSources.length === 0) {
            throw new Error(`Failed to resolve video sources from ${selected.sourceName}`);
        }

        return {
            server,
            videoSources,
            headers: { "Referer": REFERER, "User-Agent": AGENT },
        };
    }
}

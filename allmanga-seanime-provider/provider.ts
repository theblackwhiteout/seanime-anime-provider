/// <reference path="./online-streaming-provider.d.ts" />
/// <reference path="./core.d.ts" />

// AllManga (allmanga.to) — Seanime Online Streaming Provider

interface GraphQLResponse {
    data?: any;
}

interface ClockResponse {
    links?: Array<{
        link: string;
        headers?: {
            Referer?: string;
        };
        resolutionStr?: string;
    }>;
}

const BASE = "https://allmanga.to";
const API_HOST = "https://api.allanime.day";
const REFERER = "https://allmanga.to/";
const AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Byte-to-character map for AllManga URL obfuscation
const DECODE_MAP: Record<string, string> = {
    "79": "A", "7a": "B", "7b": "C", "7c": "D", "7d": "E", "7e": "F", "7f": "G", "70": "H",
    "71": "I", "72": "J", "73": "K", "74": "L", "75": "M", "76": "N", "77": "O", "68": "P",
    "69": "Q", "6a": "R", "6b": "S", "6c": "T", "6d": "U", "6e": "V", "6f": "W", "60": "X",
    "61": "Y", "62": "Z", "59": "a", "5a": "b", "5b": "c", "5c": "d", "5d": "e", "5e": "f",
    "5f": "g", "50": "h", "51": "i", "52": "j", "53": "k", "54": "l", "55": "m", "56": "n",
    "57": "o", "48": "p", "49": "q", "4a": "r", "4b": "s", "4c": "t", "4d": "u", "4e": "v",
    "4f": "w", "40": "x", "41": "y", "42": "z", "08": "0", "09": "1", "0a": "2", "0b": "3",
    "0c": "4", "0d": "5", "0e": "6", "0f": "7", "00": "8", "01": "9", "15": "-", "16": ".",
    "67": "_", "46": "~", "02": ":", "17": "/", "07": "?", "1b": "#", "63": "[", "65": "]",
    "78": "@", "19": "!", "1c": "$", "1e": "&", "10": "(", "11": ")", "12": "*", "13": "+",
    "14": ",", "03": ";", "05": "=", "1d": "%"
};

function decodeUrl(encoded: string): string {
    let out = "";
    for (let i = 0; i < encoded.length; i += 2) {
        const byte = encoded.substring(i, i + 2);
        out += DECODE_MAP[byte] ?? "";
    }
    return out.replace(/\/clock/g, "/clock.json");
}

async function fetchWithRetry(url: string, options: any = {}, retries: number = 3): Promise<any> {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, {
                headers: {
                    "User-Agent": AGENT,
                    "Referer": REFERER,
                    ...options.headers
                },
                ...options
            });
            if (response.ok) return response;
            if (response.status >= 500) throw new Error(`Server error: ${response.status}`);
            return response; // Return non-5xx errors immediately
        } catch (e: any) {
            if (i === retries - 1) throw e;
            console.log(`[AllManga] Retry ${i + 1}/${retries} for ${url}`);
            $sleep(1000 * (i + 1));
        }
    }
    throw new Error("Max retries exceeded");
}

async function gqlRequest(query: string, variables: Record<string, any>): Promise<GraphQLResponse> {
    console.log(`[AllManga] GraphQL query for: ${variables.search?.query || variables.showId || variables.episodeString}`);
    
    const response = await fetchWithRetry(`${API_HOST}/api`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ variables, query })
    });
    
    if (!response.ok) throw new Error(`GQL request failed: ${response.status}`);
    return response.json();
}

async function resolveSource(source: any): Promise<VideoSource[]> {
    let rawUrl: string = source.sourceUrl ?? "";
    
    if (!rawUrl) {
        console.warn("[AllManga] No sourceUrl in source");
        return [];
    }

    console.log(`[AllManga] Resolving source from: ${source.sourceName}`);

    // Decode obfuscated URLs
    if (rawUrl.startsWith("--")) {
        rawUrl = decodeUrl(rawUrl.slice(2));
    }

    // Build absolute URL
    const absoluteUrl = rawUrl.startsWith("http")
        ? rawUrl
        : `${BASE}${rawUrl.startsWith("/") ? rawUrl : "/" + rawUrl}`;

    // Handle fast4speed direct streams
    if (absoluteUrl.includes("tools.fast4speed.rsvp")) {
        console.log("[AllManga] Detected fast4speed stream");
        return [{
            url: absoluteUrl,
            quality: "1080p",
            type: "m3u8",
            subtitles: []
        }];
    }

    // Fetch clock endpoint
    let clockData: ClockResponse;
    try {
        console.log(`[AllManga] Fetching clock endpoint...`);
        const res = await fetchWithRetry(absoluteUrl, {
            headers: { "Accept": "application/json" }
        });
        
        if (!res.ok) {
            throw new Error(`Clock fetch failed: ${res.status}`);
        }
        
        const text = await res.text();
        clockData = JSON.parse(text);
    } catch (e: any) {
        console.error(`[AllManga] Clock fetch error: ${e.message}`);
        return [];
    }

    const links = clockData?.links ?? [];
    if (links.length === 0) {
        console.warn("[AllManga] No links in clock response");
        return [];
    }

    console.log(`[AllManga] Found ${links.length} link(s) from clock endpoint`);

    const videoSources: VideoSource[] = [];

    for (const linkObj of links) {
        const link = linkObj.link ?? "";
        if (!link) continue;

        const referer = linkObj.headers?.Referer ?? REFERER;

        // Handle wixmp repackager URLs
        if (link.includes("repackager.wixmp.com")) {
            try {
                console.log("[AllManga] Processing wixmp repackager URL");
                const stripped = link.split(".urlset")[0].replace("repackager.wixmp.com/", "");
                const parts = stripped.split(",");
                const base = parts[0];
                const suffix = parts[parts.length - 1];
                const qualities = parts.slice(1, -1);
                
                for (const q of qualities) {
                    videoSources.push({
                        url: base + q + suffix,
                        quality: q,
                        type: "m3u8",
                        subtitles: []
                    });
                }
            } catch (e: any) {
                console.error(`[AllManga] Wixmp parse error: ${e.message}`);
            }
            continue;
        }

        // Handle m3u8 playlists
        try {
            console.log(`[AllManga] Fetching m3u8 playlist...`);
            const playlistRes = await fetchWithRetry(link, {
                headers: { "Referer": referer }
            });
            
            if (!playlistRes.ok) {
                throw new Error(`Playlist fetch failed: ${playlistRes.status}`);
            }
            
            const playlistText = await playlistRes.text();
            if (!playlistText) {
                console.warn("[AllManga] Empty playlist response");
                continue;
            }

            // Parse m3u8 variants
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
                    subtitles: []
                });
            }

            // If no variants, use as direct stream
            if (!foundVariants) {
                console.log("[AllManga] No m3u8 variants, using direct stream");
                videoSources.push({
                    url: link,
                    quality: linkObj.resolutionStr ?? "auto",
                    type: "m3u8",
                    subtitles: []
                });
            }
        } catch (e: any) {
            console.error(`[AllManga] M3u8 parse error: ${e.message}`);
            videoSources.push({
                url: link,
                quality: linkObj.resolutionStr ?? "auto",
                type: link.includes(".m3u8") ? "m3u8" : "mp4",
                subtitles: []
            });
        }
    }

    console.log(`[AllManga] Resolved ${videoSources.length} video source(s)`);
    return videoSources;
}

class Provider {
    getSettings(): Settings {
        return {
            episodeServers: ["Luf-Mp4", "S-Mp4", "Yt-mp4", "Default"],
            supportsDub: true
        };
    }

    async search(query: SearchOptions): Promise<SearchResult[]> {
        const translationType = query.dub ? "dub" : "sub";

        const gql = `
            query($search:SearchInput $limit:Int $page:Int $translationType:VaildTranslationTypeEnumType){
                shows(search:$search limit:$limit page:$page translationType:$translationType){
                    edges{ _id name availableEpisodes }
                }
            }
        `;

        try {
            const data = await gqlRequest(gql, {
                search: { query: query.query, allowAdult: false, allowUnknown: false },
                limit: 20,
                page: 1,
                translationType
            });

            const edges = data?.data?.shows?.edges ?? [];
            console.log(`[AllManga] Found ${edges.length} anime(s)`);
            
            return edges.map((s: any) => ({
                id: `${s._id}|||${translationType}`,
                title: s.name,
                url: `${BASE}/bangumi/${s._id}`,
                subOrDub: translationType as SubOrDub
            }));
        } catch (e: any) {
            console.error(`[AllManga] Search error: ${e.message}`);
            throw new Error(`AllManga search failed: ${e.message}`);
        }
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const [showId, language] = id.split("|||");
        const lang = language === "dub" ? "dub" : "sub";

        const gql = `query($showId:String!){ show(_id:$showId){ _id availableEpisodesDetail } }`;
        
        try {
            const data = await gqlRequest(gql, { showId });
            const detail = data?.data?.show?.availableEpisodesDetail;
            const eps: string[] = lang === "dub" ? (detail?.dub ?? []) : (detail?.sub ?? []);

            console.log(`[AllManga] Found ${eps.length} episode(s)`);

            return eps
                .map(e => ({
                    id: `${showId}|||${lang}|||${e}`,
                    title: `Episode ${e}`,
                    number: parseFloat(e),
                    url: `${BASE}/bangumi/${showId}/episodes/${e}`
                }))
                .sort((a, b) => a.number - b.number);
        } catch (e: any) {
            console.error(`[AllManga] Episode fetch error: ${e.message}`);
            throw new Error(`AllManga episode fetch failed: ${e.message}`);
        }
    }

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

        try {
            const data = await gqlRequest(gql, { showId, translationType, episodeString });
            const episodeData = data?.data?.episode;
            const sources: any[] = episodeData?.sourceUrls ?? [];

            if (sources.length === 0) {
                throw new Error(`No sources for episode ${episodeString}`);
            }

            console.log(`[AllManga] Found ${sources.length} source(s)`);

            // Preferred server names in priority order
            const priority = ["Luf-Mp4", "S-Mp4", "Yt-mp4", "Default"];

            // Try the requested server first
            let selected = sources.find(s =>
                s.sourceName?.toLowerCase() === server.toLowerCase()
            );
            
            // Fall back through priority list
            if (!selected) {
                for (const name of priority) {
                    selected = sources.find(s =>
                        s.sourceName?.toLowerCase() === name.toLowerCase()
                    );
                    if (selected) break;
                }
            }
            
            // Last resort
            if (!selected) selected = sources[0];

            console.log(`[AllManga] Using source: ${selected.sourceName}`);

            const videoSources = await resolveSource(selected);

            if (videoSources.length === 0) {
                throw new Error(`Failed to resolve any video sources`);
            }

            return {
                server,
                videoSources,
                headers: { "Referer": REFERER, "User-Agent": AGENT }
            };
        } catch (e: any) {
            console.error(`[AllManga] Server error: ${e.message}`);
            throw new Error(`AllManga server failed: ${e.message}`);
        }
    }
}

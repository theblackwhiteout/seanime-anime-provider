/// <reference path="./online-streaming-provider.d.ts" />
/// <reference path="./core.d.ts"/>

class Provider {
    private api: string = "{{baseUrl}}";

    getSettings(): Settings {
        return {
            episodeServers: ["VidE", "VidStream"],
            supportsDub: true,
        };
    }

    async search(query: SearchOptions): Promise<SearchResult[]> {
        const url = `${this.api}/search?keyword=${encodeURIComponent(query.query)}`;

        try {
            const html = await this.GETText(url);
            const $ = LoadDoc(html);

            const results: SearchResult[] = [];

            $("div.film_list-wrap div.flw-item").each((_, el) => {
                const href = el.find("a.film-poster-ahref").attr("href") ?? "";
                const title = el.find("h3.film-name a").attr("title") ?? "";

                results.push({
                    id: href,
                    url: `${this.api}${href}`,
                    title,
                    subOrDub: "both"
                });
            });

            return results;
        } catch (e: any) {
            throw new Error(e);
        }
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const url = `${this.api}${id}`;

        try {
            const html = await this.GETText(url);

            const match = html.match(/data-id="(\d+)"/);
            if (!match) throw new Error("Anime ID not found");

            const animeId = match[1];

            const ajax = await this.GETJson<any>(
                `${this.api}/ajax/episode/list/${animeId}`
            );

            const $ = LoadDoc(ajax.html);

            const episodes: EpisodeDetails[] = [];

            $("a.ep-item").each((_, el) => {
                const num = parseInt(el.attr("data-number") ?? "0");

                episodes.push({
                    id: el.attr("data-id") ?? String(num),
                    number: num,
                    title: `Episode ${num}`,
                    url: `${this.api}/Watch?id=${el.attr("data-number")}`
                });
            });

            return episodes.reverse();
        } catch (e: any) {
            throw new Error(e);
        }
    }

    async findEpisodeServer(
        episode: EpisodeDetails,
        server: string
    ): Promise<EpisodeServer> {

        const watchUrl = episode.url;

        try {
            const html = await this.GETText(watchUrl);

            let iframe = html.match(/<iframe[^>]+src=["']([^"']+)["']/i)?.[1];

            if (!iframe) {
                throw new Error("Player iframe not found");
            }

            if (!iframe.startsWith("http")) {
                iframe = new URL(iframe, this.api).href;
            }

            const playerHtml = await this.GETText(iframe);

            const streamMatch =
                playerHtml.match(/https?:\/\/[^"']+\.m3u8[^"']*/i) ||
                playerHtml.match(/file:\s*["']([^"']+\.m3u8[^"']*)["']/i);

            if (!streamMatch) {
                throw new Error("Stream not found");
            }

            const streamUrl = streamMatch[1].replace(/\\\//g, "/");

            const videoSources: VideoSource[] = [
                {
                    quality: "auto",
                    url: streamUrl,
                    type: "hls",
                    subtitles: []
                }
            ];

            return {
                server: server === "default" ? "VidStream" : server,
                headers: {
                    Referer: iframe,
                    Origin: new URL(iframe).origin,
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
                },
                videoSources
            };

        } catch (e: any) {
            throw new Error(e);
        }
    }

    async _makeRequest(url: string): Promise<FetchResponse> {
        const res = await fetch(url, {
            method: "GET",
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
                Referer: this.api
            }
        });

        if (!res.ok) {
            throw new Error(`Request failed: ${res.status}`);
        }

        return res;
    }

    async GETText(url: string): Promise<string> {
        return await this._makeRequest(url).then(r => r.text());
    }

    async GETJson<T>(url: string): Promise<T> {
        return await this._makeRequest(url).then(r => r.json());
    }
}

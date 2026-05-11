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

            $("div.film_list-wrap div.flw-item").each((_, elem) => {
                const id = elem.find("a.film-poster-ahref").attr("href") ?? "";
                const title = elem.find("h3.film-name a").attr("title") ?? "";

                results.push({
                    id: `${id}?dub=${query.dub}`,
                    url: `${this.api}${id}`,
                    title: title,
                    subOrDub: "both"
                });
            });

            return results;
        } catch (e: any) {
            throw new Error(e);
        }
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const animeId = id.split("?dub")[0];
        const url = `${this.api}${animeId}`;

        try {
            const html = await this.GETText(url);

            const animeMatch = html.match(/data-id="(\d+)"/);
            if (!animeMatch) {
                throw new Error("Anime ID not found");
            }

            const internalId = animeMatch[1];

            const ajaxUrl = `${this.api}/ajax/episode/list/${internalId}`;
            const response = await this.GETJson<any>(ajaxUrl);

            const $ = LoadDoc(response.html);

            const episodes: EpisodeDetails[] = [];

            $("a.ep-item").each((_, elem) => {
                const epNum = parseInt(elem.attr("data-number") ?? "0");

                episodes.push({
                    id: elem.attr("data-id") ?? "",
                    number: epNum,
                    title: `Episode ${epNum}`,
                    url: `${this.api}/ajax/episode/servers/${elem.attr("data-id")}?dub=${id.split("?dub=")[1]}`
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

        const dubRequested = episode.url.split("?dub=")[1] === "true";
        const serverName = server === "default" ? "VidStream" : server;

        try {
            const response = await this.GETJson<any>(episode.url.split("?dub")[0]);

            const $ = LoadDoc(response.html);

            let serverId = "";

            $("div.server-item").each((_, elem) => {
                const name = elem.text().trim();

                if (
                    name.includes(serverName) &&
                    (
                        (dubRequested && elem.attr("data-type") === "dub") ||
                        (!dubRequested && elem.attr("data-type") === "sub")
                    )
                ) {
                    serverId = elem.attr("data-id") ?? "";
                }
            });

            if (!serverId) {
                throw new Error("Server not found");
            }

            const sourceResponse = await this.GETJson<any>(
                `${this.api}/ajax/episode/sources/${serverId}`
            );

            const link = sourceResponse.link;

            const videoSources: VideoSource[] = [
                {
                    quality: "auto",
                    url: link,
                    type: "hls",
                    subtitles: []
                }
            ];

            return {
                server: serverName,
                headers: {
                    Referer: this.api,
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
                },
                videoSources: videoSources
            };

        } catch (e: any) {
            throw new Error(e);
        }
    }

    async _makeRequest(url: string): Promise<FetchResponse> {
        const response = await fetch(url, {
            method: "GET",
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
                Referer: this.api
            }
        });

        if (!response.ok) {
            throw new Error(`Failed request: ${response.status}`);
        }

        return response;
    }

    async GETText(url: string): Promise<string> {
        return await this._makeRequest(url).then(res => res.text());
    }

    async GETJson<T>(url: string): Promise<T> {
        return await this._makeRequest(url).then(res => res.json());
    }
}

/// <reference path="./online-streaming-provider.d.ts" />
/// <reference path="./core.d.ts" />

class Provider {

    api = "{{baseUrl}}"

    getSettings(): Settings {
        return {
            episodeServers: [
                "VidE 1", "VidE 2",
                "VidStream 1", "VidStream 2"
            ],
            supportsDub: true,
        }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const html = await this.GETText(
            `${this.api}/search?keyword=${encodeURIComponent(opts.query)}`
        )

        const $ = LoadDoc(html)
        const results: SearchResult[] = []

        $("div.film_list-wrap div.flw-item").each((_, el) => {
            const id = el.find("a.film-poster-ahref").attr("href") ?? ""
            const title = el.find("h3.film-name a").attr("title") ?? ""

            results.push({
                id,
                url: `${this.api}${id}`,
                title,
                subOrDub: "both"
            })
        })

        return results
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const html = await this.GETText(`${this.api}${id}`)
        const $ = LoadDoc(html)

        const episodes: EpisodeDetails[] = []

        $("a.ep-item").each((_, el) => {
            const ep = parseInt(el.attr("data-number") ?? "0")

            episodes.push({
                id: `${el.attr("data-id")}`,
                number: ep,
                title: `Episode ${ep}`,
                url: `${this.api}/Watch?id=${el.attr("data-number")}`
            })
        })

        return episodes.reverse()
    }

    async findEpisodeServer(
        episode: EpisodeDetails,
        server: string
    ): Promise<EpisodeServer> {

        const watchHtml = await this.GETText(episode.url)

        // 1. Extract embed (Megaplay)
        const embed =
            watchHtml.match(/<iframe[^>]+src=["']([^"']+)["']/i)?.[1]

        if (!embed) throw new Error("Embed not found")

        const embedUrl = embed.startsWith("http")
            ? embed
            : new URL(embed, this.api).href

        // 2. Load Megaplay page
        const playerHtml = await this.GETText(embedUrl)

        // 3. Megaplay usually hides sources inside JS variables or fetch calls
        const apiUrl =
            playerHtml.match(/fetch\(["']([^"']*api[^"']*)["']\)/i)?.[1] ||
            playerHtml.match(/["'](https?:\/\/[^"']*(source|stream|api)[^"']*)["']/i)?.[1]

        if (!apiUrl) {
            throw new Error("Megaplay API not found")
        }

        // 4. Get JSON source
        const json = await fetch(apiUrl, {
            headers: {
                Referer: embedUrl,
                Origin: new URL(embedUrl).origin,
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137"
            }
        }).then(r => r.json())

        // 5. Extract stream
        const stream =
            json?.sources?.[0]?.file ||
            json?.url ||
            json?.source

        if (!stream) throw new Error("Stream not found")

        const isVidE = server.startsWith("VidE")

        return {
            server,
            headers: {
                Referer: embedUrl,
                Origin: new URL(embedUrl).origin,
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137"
            },
            videoSources: [
                {
                    url: stream,
                    type: "hls",
                    quality: isVidE ? "VidE" : "VidStream",
                    subtitles: []
                }
            ]
        }
    }

    async _makeRequest(url: string): Promise<FetchResponse> {
        const res = await fetch(url, {
            headers: {
                Referer: this.api,
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137"
            }
        })

        if (!res.ok) throw new Error("Request failed")
        return res
    }

    async GETText(url: string) {
        return await this._makeRequest(url).then(r => r.text())
    }
}

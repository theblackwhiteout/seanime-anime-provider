/// <reference path="../goja_onlinestream_test/onlinestream-provider.d.ts" />
/// <reference path="../goja_plugin_types/core.d.ts" />

type AjaxServerResponse = {
    html: string;
}

type AjaxSourceResponse = {
    link: string;
    type: string;
}

class Provider {
    api = "https://anirose.to"

    getSettings(): Settings {
        return {
            // Updated to only include vidE and vidstream
            episodeServers:["VidE", "VidStream"],
            supportsDub: true, // Set to false if Anigum doesn't separate sub/dub here
        }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const req = await fetch(`${this.api}/search?keyword=${encodeURIComponent(opts.query)}`)
        if (!req.ok) return[]

        const html = await req.text()
        const $ = LoadDoc(html)
        const results: SearchResult[] =[]

        // Extracting anime from Anigum's search results page
        $(".film_list-wrap .flw-item").each((_, el) => {
            const titleEl = $(el).find(".film-name a")
            const title = titleEl.text().trim()
            const url = titleEl.attr("href") ?? ""
            const id = url.split("/").pop() ?? ""
            
            if (id && title) {
                results.push({
                    id: id,
                    title: title,
                    url: `${this.api}${url}`,
                    subOrDub: "sub", 
                })
            }
        })

        return results
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        // Fetch the Anigum watch/details page
        const req = await fetch(`${this.api}/watch/${id}`)
        if (!req.ok) throw new Error("Anime not found")

        const html = await req.text()
        const $ = LoadDoc(html)
        const episodes: EpisodeDetails[] =[]

        // Parsing the episode list
        $("#episodes-list a.ep-item").each((_, el) => {
            const epNumStr = $(el).attr("data-number") ?? "0"
            const epNum = parseFloat(epNumStr) // Using float just in case there are .5 episodes
            const epId = $(el).attr("data-id") ?? ""
            const epTitle = $(el).attr("title") ?? `Episode ${epNum}`
            
            if (epId) {
                episodes.push({
                    id: epId,
                    number: epNum,
                    title: epTitle,
                    url: `${this.api}/watch/${id}?ep=${epId}`
                })
            }
        })

        return episodes.sort((a, b) => a.number - b.number)
    }

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        // Step 1: Hit Anigum's internal ajax endpoint to get the servers for the specific episode
        const ajaxReq = await fetch(`${this.api}/ajax/episode/servers?episodeId=${episode.id}`)
        if (!ajaxReq.ok) throw new Error("Failed to fetch servers from Anigum.")
        
        const ajaxData = await ajaxReq.json() as AjaxServerResponse
        const $ = LoadDoc(ajaxData.html)
        
        let serverId = ""

        // Find the server data-id matching "vidE" or "vidstream"
        $(".server-item").each((_, el) => {
            const serverName = $(el).text().trim().toLowerCase()
            if (serverName.includes(server.toLowerCase())) {
                serverId = $(el).attr("data-id") ?? ""
            }
        })

        // Fallback to the first available server if the requested one is missing
        if (!serverId) {
            serverId = $(".server-item").first().attr("data-id") ?? ""
        }
        if (!serverId) throw new Error("No servers found for this episode.")

        // Step 2: Extract the actual streaming source using the extracted Server ID
        const linkReq = await fetch(`${this.api}/ajax/episode/sources?id=${serverId}`)
        const linkData = await linkReq.json() as AjaxSourceResponse

        // Step 3: Parse and return the video stream to Seanime
        // Note: If linkData.link gives an iframe URL instead of an M3U8, 
        // you would need one more fetch here to scrape the iframe for the raw stream link.
        return {
            videoSources:[{
                url: linkData.link,
                type: linkData.link.includes(".m3u8") ? "m3u8" : "mp4",
                quality: "auto",
                subtitles: [], 
                headers: { Referer: this.api }
            }],
            headers: { Referer: this.api },
            server: server,
        }
    }
}

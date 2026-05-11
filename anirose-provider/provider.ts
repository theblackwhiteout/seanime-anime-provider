async findEpisodeServer(
    episode: EpisodeDetails,
    server: string
): Promise<EpisodeServer> {

    const watchUrl = episode.url;

    try {
        // 1. Load AniRose watch page
        const watchHtml = await this.GETText(watchUrl);

        const iframeSrc = watchHtml.match(
            /<iframe[^>]+src=["']([^"']+)["']/i
        )?.[1];

        if (!iframeSrc) {
            throw new Error("Iframe not found on watch page");
        }

        const iframeUrl = iframeSrc.startsWith("http")
            ? iframeSrc
            : new URL(iframeSrc, this.api).href;

        // 2. Load Megaplay page
        const playerHtml = await this.GETText(iframeUrl);

        // 3. Find JS API endpoint (Megaplay loads sources dynamically)
        const apiMatch =
            playerHtml.match(/fetch\(["']([^"']*api[^"']*)["']\)/i) ||
            playerHtml.match(/["'](https?:\/\/[^"']*\/sources[^"']*)["']/i) ||
            playerHtml.match(/["'](https?:\/\/[^"']*\/get[^"']*)["']/i);

        if (!apiMatch) {
            throw new Error("Megaplay API endpoint not found");
        }

        const apiUrl = apiMatch[1];

        // 4. Request stream source JSON
        const json = await fetch(apiUrl, {
            headers: {
                Referer: iframeUrl,
                Origin: new URL(iframeUrl).origin,
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137"
            }
        }).then(r => r.json());

        // 5. Extract stream URL
        const streamUrl =
            json?.sources?.[0]?.file ||
            json?.source ||
            json?.url;

        if (!streamUrl) {
            throw new Error("Stream URL not found in Megaplay response");
        }

        // 6. Return to Seanime
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
                Referer: iframeUrl,
                Origin: new URL(iframeUrl).origin,
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137"
            },
            videoSources
        };

    } catch (e: any) {
        throw new Error(e);
    }
}

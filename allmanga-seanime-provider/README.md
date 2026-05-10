# AllManga — Seanime Extension

A [Seanime](https://github.com/5rahim/seanime) online streaming provider for [allmanga.to](https://allmanga.to), supporting both **sub** and **dub** anime.

---

## Installation

1. Open **Seanime** and go to the **Extensions** tab.
2. Click **Add Extension**.
3. Paste the raw URL of `manifest.json`:

```
https://raw.githubusercontent.com/theblackwhiteout/seanime-anime-provider/main/manifest.json
```

4. Click **Install**.

---

## Features

- Sub & dub support
- Automatic server fallback (tries `wixmp` → `S-mp4` → `Luf-Mp4` → `Mp4` → `Default`)
- Decodes AllManga's obfuscated source URLs
- Written in TypeScript

---

## File Structure

```
seanime-anime-provider/
├── provider.ts                  # Extension logic
├── manifest.json                # Seanime extension manifest
└── README.md
```

---

## How It Works

Seanime calls three methods on the `Provider` class:

| Method | Input | Output |
|---|---|---|
| `search(opts)` | `{ query, dub }` | `SearchResult[]` |
| `findEpisodes(id)` | Show ID string | `EpisodeDetails[]` |
| `findEpisodeServer(episode, server)` | Episode object + server name | `EpisodeServer` |

The provider queries AllManga's GraphQL API at `api.allanime.day`, decodes obfuscated source URLs using a byte-map, then fetches the resolved clock endpoint to get the final video links.

---

## Updating

When AllManga changes its API or domain, update the constants at the top of `provider.ts`:

```ts
const BASE     = "https://allmanga.to";
const API_HOST = "https://api.allanime.day";
const REFERER  = "https://allmanga.to/";
```

Then bump the `version` field in `manifest.json` — Seanime will detect the update automatically.

---

## Disclaimer

This extension does not host or distribute any media content. It is an interface to a third-party website. You are responsible for complying with the laws in your region.

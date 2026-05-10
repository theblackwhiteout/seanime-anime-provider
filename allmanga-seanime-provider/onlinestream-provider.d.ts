// Type definitions for the Seanime onlinestream-provider extension interface.
// Reference this file at the top of provider.js for editor autocompletion.
// Do NOT modify — this file is not loaded by Seanime at runtime.

declare type Settings = {
  /** List of server names this provider can serve. Shown in the Seanime UI. */
  episodeServers: string[];
  /** Whether this provider supports dubbed audio. */
  supportsDub: boolean;
};

declare type SearchQuery = {
  /** The anime title to search for. */
  query: string;
  /** True when the user has requested dubbed audio. */
  dub: boolean;
};

declare type SearchResult = {
  /** Unique identifier for this anime. Passed back to findEpisodes(). */
  id: string;
  title: string;
  url: string;
  /** "sub" | "dub" */
  subOrDub: string;
  image?: string;
};

declare type Episode = {
  /** Unique identifier for this episode. Passed back to findEpisodeServer(). */
  id: string;
  title: string;
  number: number;
  url: string;
  image?: string;
  description?: string;
};

declare type VideoSource = {
  url: string;
  /** e.g. "1080p", "720p", "auto" */
  quality: string;
  /** "m3u8" | "mp4" */
  type: string;
  subtitles?: { url: string; lang: string; label: string }[];
};

declare type EpisodeServer = {
  server: string;
  videoSources: VideoSource[];
  headers?: { [key: string]: string };
};

declare abstract class OnlinestreamProvider {
  getSettings(): Settings;
  search(query: SearchQuery): Promise<SearchResult[]>;
  findEpisodes(id: string): Promise<Episode[]>;
  findEpisodeServer(episode: Episode, server: string): Promise<EpisodeServer>;
}

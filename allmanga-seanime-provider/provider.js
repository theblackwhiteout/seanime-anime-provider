/// <reference path="./onlinestream-provider.d.ts" />

// AllManga (allmanga.to) online streaming provider for Seanime
// Rewritten in ES5 for compatibility with Seanime's embedded JS engine.

var BASE     = "https://allmanga.to";
var API_HOST = "https://api.allanime.day";
var REFERER  = "https://allmanga.to/";
var AGENT    = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0";

// Byte-to-character decode map used by AllManga's URL obfuscation
var DECODE_MAP = {
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
  "14":",","03":";","05":"=","1d":"%"
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decodeUrl(encoded) {
  var out = "";
  for (var i = 0; i < encoded.length; i += 2) {
    var b = encoded.substring(i, i + 2);
    out += (DECODE_MAP[b] !== undefined) ? DECODE_MAP[b] : "";
  }
  // AllManga clock endpoints require a .json suffix
  out = out.replace(/\/clock/g, "/clock.json");
  return out;
}

function arrayFind(arr, predicate) {
  for (var i = 0; i < arr.length; i++) {
    if (predicate(arr[i])) return arr[i];
  }
  return undefined;
}

function gqlRequest(query, variables) {
  return fetch(API_HOST + "/api", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Referer": REFERER,
      "User-Agent": AGENT
    },
    body: JSON.stringify({ variables: variables, query: query })
  }).then(function(res) {
    if (!res.ok) throw new Error("GQL request failed: " + res.status);
    return res.json();
  });
}

function resolveSource(source, server) {
  var rawUrl     = source.sourceUrl || "";
  var sourceName = source.sourceName || "";

  if (rawUrl.indexOf("--") === 0) {
    rawUrl = decodeUrl(rawUrl.slice(2));
  }

  var absoluteUrl;
  if (rawUrl.indexOf("http") === 0) {
    absoluteUrl = rawUrl;
  } else {
    absoluteUrl = BASE + (rawUrl.indexOf("/") === 0 ? rawUrl : "/" + rawUrl);
  }

  return fetch(absoluteUrl, {
    headers: {
      "Referer": REFERER,
      "User-Agent": AGENT
    }
  }).then(function(res) {
    if (!res.ok) throw new Error("Clock API returned " + res.status);
    return res.json();
  }).then(function(json) {
    if (!json.links || !Array.isArray(json.links)) {
      throw new Error("Response missing 'links' array");
    }

    var videoSources = [];
    for (var i = 0; i < json.links.length; i++) {
      var link = json.links[i];
      videoSources.push({
        url:       link.link,
        quality:   link.resolutionStr || "auto",
        type:      (link.link && link.link.indexOf(".m3u8") !== -1) ? "m3u8" : "mp4",
        subtitles: []
      });
    }

    return { server: server, videoSources: videoSources, headers: {} };
  }).catch(function(err) {
    console.error("[AllManga] Resolution error for " + sourceName + ": " + err.message);
    return { server: server, videoSources: [], headers: {} };
  });
}

// ---------------------------------------------------------------------------
// Provider — ES5 constructor pattern required by Seanime's JS engine
// ---------------------------------------------------------------------------

function Provider() {}

Provider.prototype.getSettings = function() {
  return {
    episodeServers: ["wixmp", "S-mp4", "Luf-Mp4", "Mp4", "Default"],
    supportsDub: true
  };
};

// Called by Seanime with: { query: string, dub: boolean }
Provider.prototype.search = function(query) {
  var translationType = query.dub ? "dub" : "sub";

  var gqlQuery = [
    "query($search:SearchInput $limit:Int $page:Int $translationType:VaildTranslationTypeEnumType){",
    "  shows(search:$search limit:$limit page:$page translationType:$translationType){",
    "    edges{ _id name availableEpisodes }",
    "  }",
    "}"
  ].join("\n");

  return gqlRequest(gqlQuery, {
    search: {
      query: query.query,
      allowAdult: false,
      allowUnknown: false
    },
    limit: 20,
    page: 1,
    translationType: translationType
  }).then(function(data) {
    var edges = (data && data.data && data.data.shows && data.data.shows.edges) || [];
    var results = [];
    for (var i = 0; i < edges.length; i++) {
      var s = edges[i];
      results.push({
        id:       s._id + "|||" + translationType,
        title:    s.name,
        url:      BASE + "/bangumi/" + s._id,
        subOrDub: translationType
      });
    }
    return results;
  });
};

// Called by Seanime with the id returned from search()
// id format: "showId|||lang"
Provider.prototype.findEpisodes = function(id) {
  var parts    = id.split("|||");
  var showId   = parts[0];
  var language = (parts[1] === "dub") ? "dub" : "sub";

  var gqlQuery = "query($showId:String!){ show(_id:$showId){ _id availableEpisodesDetail } }";

  return gqlRequest(gqlQuery, { showId: showId }).then(function(data) {
    var detail = data && data.data && data.data.show && data.data.show.availableEpisodesDetail;
    var eps    = (language === "dub")
      ? ((detail && detail.dub) || [])
      : ((detail && detail.sub) || []);

    var episodes = [];
    for (var i = 0; i < eps.length; i++) {
      var e = eps[i];
      episodes.push({
        id:     showId + "|||" + language + "|||" + e,
        title:  "Episode " + e,
        number: parseFloat(e),
        url:    BASE + "/bangumi/" + showId + "/episodes/" + e
      });
    }

    episodes.sort(function(a, b) { return a.number - b.number; });
    return episodes;
  });
};

// Called by Seanime with an episode object from findEpisodes() and a server name string
// episode.id format: "showId|||lang|||episodeString"
Provider.prototype.findEpisodeServer = function(episode, server) {
  var parts = episode.id.split("|||");
  if (parts.length !== 3) {
    return Promise.reject(new Error("Invalid episode ID format: " + episode.id));
  }

  var showId          = parts[0];
  var translationType = parts[1];
  var episodeString   = parts[2];

  var gqlQuery = [
    "query($showId:String! $translationType:VaildTranslationTypeEnumType! $episodeString:String!){",
    "  episode(showId:$showId translationType:$translationType episodeString:$episodeString){ sourceUrls }",
    "}"
  ].join("\n");

  return gqlRequest(gqlQuery, {
    showId:          showId,
    translationType: translationType,
    episodeString:   episodeString
  }).then(function(data) {
    var sources = data && data.data && data.data.episode && data.data.episode.sourceUrls;

    if (!sources || sources.length === 0) {
      throw new Error("No sources found for episode " + episodeString);
    }

    var priority = ["wixmp", "S-mp4", "Luf-Mp4", "Mp4", "Default"];

    // Try the requested server first, then walk the priority list
    var selected = arrayFind(sources, function(s) {
      return s.sourceName && s.sourceName.toLowerCase() === server.toLowerCase();
    });

    if (!selected) {
      for (var i = 0; i < priority.length; i++) {
        var name = priority[i];
        selected = arrayFind(sources, function(s) {
          return s.sourceName && s.sourceName.toLowerCase() === name.toLowerCase();
        });
        if (selected) break;
      }
    }

    return resolveSource(selected || sources[0], server);
  });
};

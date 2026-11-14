// @ts-check
/// <reference path="../../types/rex-addons.d.ts" />
// Your Spotify library in rex, as music: liked songs, your playlists and saved albums, each track
// with Spotify's own title, artists, album, numbers, date and cover. Each Spotify playlist, and
// Liked Songs, is a rex playlist in Spotify's order. Spotify's audio is out of reach, so each track
// plays as its recording on YouTube, found and played through the YouTube addon with its own sign-in.
//
// A track reaches rex once YouTube has a recording of it at its length: a few are looked for each
// sync (the setting), each one once for good; a track YouTube has none of is looked for again after
// a week. What rex is told about the file (AAC from YouTube, its length, size and rate) comes from
// that one look, so no track is probed.
//
// Signing in is Spotify's own OAuth device flow (a code entered at spotify.com/pair), and the
// library is read with that token from Spotify's own API (spclient), each a plain fetch: the
// playlists list (`rootlist`), each playlist again only when its revision changed, liked songs and
// saved albums (`collection`), each in pages, and each track's details once. All of it was answered
// with only the bearer token, no client token (measured 2026-11-14).

const ACCOUNTS = "https://accounts.spotify.com";
const APRESOLVE = "https://apresolve.spotify.com/?type=spclient";
// Spotify's own desktop client, which takes the device flow; the token it gives works on spclient.
const CLIENT_ID = "65b708073fc0480ea92a077233ca87bd";
const SCOPES = "playlist-read-private,playlist-read-collaborative,user-library-read,user-read-private";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
// Why an install signed in by 1.x's pairing (its sign-in kept by the host, not here) signs in again.
const AFTER_UPDATE = "this update signs in to Spotify with a code";
// apresolve's list of spclient servers is asked for again after this.
const SPCLIENT_MS = 24 * 60 * 60 * 1000;
// A 429 asking for this long or less is waited out within the call; a longer one ends the sync.
const WAIT_429_S = 10;

const B62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** A Spotify id (base 62, the end of a `spotify:track:` uri) as the hex `gid` metadata takes. */
function gid(id) {
  let n = 0n;
  for (const c of id) {
    const digit = B62.indexOf(c);
    if (digit < 0) throw new Error(`${id} is not a Spotify id`);
    n = n * 62n + BigInt(digit);
  }
  return n.toString(16).padStart(32, "0");
}
/** A hex `gid` as a Spotify id. */
function idOf(hex) {
  let n = BigInt(`0x${hex}`), out = "";
  for (; n > 0n; n /= 62n) out = B62[Number(n % 62n)] + out;
  return out.padStart(22, "0");
}

// Spotify's pages: a playlist or the playlists list is read in windows of this many once Spotify
// says an answer holds only part of it (a 400-track playlist came whole, 2026-11-11), the
// collection this many a request.
const PAGE = 100;
const COLLECTION_PAGE = 300;
// Between two Spotify lookups, and between two YouTube searches.
const SPOTIFY_PAUSE_MS = 250;
const MATCH_PAUSE_MS = 1500;
// A track YouTube has no recording of is looked for again after this.
const RETRY_MS = 7 * 24 * 60 * 60 * 1000;
const LIKED = "Liked Songs";
// A playlist Spotify refuses is asked about again after this.
const GONE_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- signing in

/** A form POST to Spotify's sign-in, its JSON answer with its status. */
async function account(path, fields) {
  const answer = await fetch(`${ACCOUNTS}${path}`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...fields }).toString(),
  });
  if (answer.status === 429) throw new Error(`RETRY_AFTER ${Number(answer.headers["retry-after"]) || 60}: Spotify's sign-in answered 429 (too many requests)`);
  if (answer.status >= 500) throw new Error(`Spotify's sign-in answered ${answer.status}`);
  let body = {};
  try {
    body = await answer.json();
  } catch {
    // An answer that is not JSON: its status says what happened.
  }
  return { status: answer.status, ...body };
}

/** Keeps a token answer: never logged, never shown (a refreshed token carries far wider scopes). */
function keep(answer) {
  const before = storage.get("tokens") ?? {};
  storage.set("tokens", {
    access: answer.access_token,
    refresh: answer.refresh_token ?? before.refresh,
    expires_at: Date.now() + (Number(answer.expires_in) || 3600) * 1000,
    // The canonical username, which the spclient paths take.
    user: answer.username ?? before.user,
  });
}

/** The access token, refreshed when it is about to expire (or `force`). */
async function accessToken(force = false) {
  const tokens = storage.get("tokens");
  if (!tokens?.refresh || !tokens.user) throw new Error(`SIGN_IN_REQUIRED: ${AFTER_UPDATE}`);
  if (!force && tokens.access && tokens.expires_at > Date.now() + 60 * 1000) return tokens.access;
  const answer = await account("/api/token", { grant_type: "refresh_token", refresh_token: tokens.refresh });
  if (answer.error === "invalid_grant") throw new Error(`SIGN_IN_REQUIRED: Spotify ended the sign-in (${answer.error_description ?? answer.error})`);
  if (answer.error || !answer.access_token) throw new Error(`Spotify's sign-in refused a refresh: ${answer.error ?? answer.status}`);
  keep(answer);
  return answer.access_token;
}

// ---------------------------------------------------------------- spclient

/** Spotify's spclient servers, as apresolve names them, kept a day: {hosts, at, checked}. */
async function spclients() {
  const kept = storage.get("spclient");
  if (kept?.hosts?.length && kept.checked > Date.now() - SPCLIENT_MS) return kept;
  const answer = await fetch(APRESOLVE, { headers: { Accept: "application/json" } });
  if (!answer.ok) throw new Error(`Spotify's apresolve answered ${answer.status}`);
  const hosts = ((await answer.json())?.spclient ?? []).filter((host) => typeof host === "string").map((host) => host.replace(/:443$/, ""));
  if (!hosts.length) throw new Error("Spotify's apresolve named no spclient server");
  const fresh = { hosts: hosts.slice(0, 5), at: 0, checked: Date.now() };
  storage.set("spclient", fresh);
  return fresh;
}

/** One spclient request with `token`, on the server last answered from, else the next ones in turn.
 * A server that cannot be reached or answers 5xx is passed over; when none answers, apresolve is
 * asked again next time. */
async function spclient(path, init, token) {
  const kept = await spclients();
  let failed = "";
  for (let tried = 0; tried < kept.hosts.length; tried++) {
    const at = (kept.at + tried) % kept.hosts.length, host = kept.hosts[at];
    try {
      const answer = await fetch(`https://${host}${path}`, {
        ...init, headers: { ...init.headers, Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (answer.status < 500) {
        if (at !== kept.at) storage.set("spclient", { ...kept, at });
        return answer;
      }
      failed = `${host} answered ${answer.status}`;
    } catch (error) {
      failed = `${host}: ${error.message.split("\n")[0]}`;
    }
    console.warn(`Spotify's server failed (${failed}); trying the next`);
  }
  storage.delete("spclient");
  throw new Error(`no Spotify server answered ${path.split("?")[0]}: ${failed}`);
}

/** `GET path`, or `POST path` with `body` as JSON, answered as JSON. The token is refreshed once
 * when Spotify refuses it, and a short 429 is waited out; a long one ends the sync with RETRY_AFTER.
 * Errors name the path, never the token. */
async function sp(path, body) {
  await sleep(SPOTIFY_PAUSE_MS);
  const init = body === undefined ? { headers: {} } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  let token = await accessToken(), refreshed = false, waited = false;
  for (;;) {
    const answer = await spclient(path, init, token);
    if (answer.status === 401 && !refreshed) {
      refreshed = true;
      token = await accessToken(true);
      continue;
    }
    if (answer.status === 401) throw new Error("SIGN_IN_REQUIRED: Spotify refused the signed-in account (401)");
    if (answer.status === 429) {
      const wait = Number(answer.headers["retry-after"]);
      if (!waited && wait >= 0 && wait <= WAIT_429_S) {
        waited = true;
        await sleep(wait * 1000);
        continue;
      }
      throw new Error(`RETRY_AFTER ${Math.max(60, wait || 0)}: Spotify answered 429 (too many requests)`);
    }
    if (!answer.ok) throw new Error(`Spotify answered ${answer.status} to ${path.split("?")[0]}`);
    return await answer.json();
  }
}

/** Every entry of a playlist (or of the playlists list, `rootlist`) at `path`, in order, following
 * Spotify's windows while it says the answer is cut short: {head, items, metaItems}. */
async function windows(path) {
  const head = await sp(`${path}${path.includes("?") ? "&" : "?"}decorate=revision,length,attributes,timestamp,owner`);
  if (!head?.contents) throw new Error(`Spotify's answer to ${path.split("?")[0]} has no contents`);
  // An empty playlist's contents have no items at all (measured 2026-11-11).
  const items = [...(head.contents.items ?? [])], metaItems = [...(head.contents.metaItems ?? [])];
  for (let truncated = head.contents.truncated; truncated;) {
    if (items.length > 20000) throw new Error(`${path.split("?")[0]}: more than 20,000 entries`);
    const page = await sp(`${path}${path.includes("?") ? "&" : "?"}decorate=revision,length,attributes,timestamp,owner&from=${items.length}&length=${PAGE}`);
    const got = page?.contents?.items ?? [];
    if (page?.contents?.pos !== items.length || !got.length) throw new Error(`Spotify answered ${path.split("?")[0]} from ${items.length} with nothing`);
    items.push(...got);
    metaItems.push(...(page.contents.metaItems ?? []));
    truncated = page.contents.truncated;
  }
  if (typeof head.length === "number" && items.length < head.length) {
    throw new Error(`${path.split("?")[0]}: Spotify listed ${items.length} of its ${head.length} entries`);
  }
  return { head, items, metaItems };
}

/** The person's playlists, folders flattened, in the order Spotify shows them: [{id, title, revision}]. */
async function playlists(user) {
  const { items, metaItems } = await windows(`/playlist/v2/user/${encodeURIComponent(user)}/rootlist`);
  const lists = items.filter((item) => item.uri?.startsWith("spotify:playlist:"));
  // Each playlist's details beside it, whether folders' markers have some (`start-group`, `end-group`)
  // or not; when neither lines up, no revision is known and every playlist is read again.
  const metas = metaItems.length === items.length ? items.map((item, at) => [item, metaItems[at]]).filter(([item]) => lists.includes(item)).map(([, meta]) => meta)
    : metaItems.length === lists.length ? metaItems : [];
  return lists.map((item, at) => ({ id: item.uri.split(":")[2], title: metas[at]?.attributes?.name ?? "", revision: metas[at]?.revision ?? null }));
}

/** A playlist's tracks, by Spotify id in its order, local files and podcast episodes left out. Read
 * again only when its revision changed. */
async function playlistTracks(playlist) {
  const kept = storage.get(`pl:${playlist.id}`);
  if (kept?.gone > Date.now()) return null;
  if (kept && !kept.gone && playlist.revision && kept.revision === playlist.revision) return kept;
  let read;
  try {
    read = await windows(`/playlist/v2/playlist/${playlist.id}`);
  } catch (error) {
    // A playlist the person follows that is gone or private now: listed with no details, and
    // answered 403 (measured 2026-11-11). It is left out, as Spotify's app shows none of it.
    if (!/^Spotify answered 40[34] /.test(error.message)) throw error;
    console.warn(`a playlist is left out for a day: ${error.message.split("\n")[0]}`);
    storage.set(`pl:${playlist.id}`, { gone: Date.now() + GONE_MS });
    return null;
  }
  const { head, items } = read;
  const listed = {
    revision: playlist.revision ?? head.revision ?? null, title: head.attributes?.name ?? playlist.title,
    tracks: items.map((item) => item.uri ?? "").filter((uri) => uri.startsWith("spotify:track:")).map((uri) => uri.split(":")[2]),
  };
  storage.set(`pl:${playlist.id}`, listed);
  return listed;
}

/** Liked songs (newest first, as Spotify shows them) and saved albums, every page. */
async function collection(user) {
  const liked = [], albums = [];
  let token = null;
  for (let page = 0; ; page++) {
    if (page > 500) throw new Error("the collection has more pages than Spotify should give");
    const answer = await sp("/collection/v2/paging", { username: user, set: "collection", limit: COLLECTION_PAGE, ...(token ? { pagination_token: token } : {}) });
    if (!Array.isArray(answer?.items)) throw new Error("Spotify's collection answer has no items");
    for (const item of answer.items) {
      const [, kind, id] = (item.uri ?? "").split(":");
      if (kind === "track") liked.push({ id, at: Number(item.added_at) || 0 });
      else if (kind === "album") albums.push(id);
    }
    token = answer.next_page_token;
    if (!token || !answer.items.length) break;
  }
  return { liked: liked.sort((a, b) => b.at - a.at).map((one) => one.id), albums };
}

/** A saved album's tracks, by Spotify id, disc by disc; an album does not change, so once. */
async function albumTracks(id) {
  let kept = storage.get(`al:${id}`);
  if (!kept) {
    const album = await sp(`/metadata/4/album/${gid(id)}?market=from_token`);
    if (!Array.isArray(album?.disc)) throw new Error(`Spotify's answer for album ${id} has no discs`);
    kept = album.disc.flatMap((disc) => (disc.track ?? []).map((track) => idOf(track.gid)));
    storage.set(`al:${id}`, kept);
  }
  return kept;
}

const cover = (group) => {
  const images = group?.image ?? [];
  const best = images.find((image) => image.size === "LARGE") ?? images.sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
  return best?.file_id ? `https://i.scdn.co/image/${best.file_id}` : undefined;
};
const dated = (date) => date?.year ? [date.year, date.month, date.day].filter(Boolean).map((n, i) => String(n).padStart(i ? 2 : 4, "0")).join("-") : undefined;

/** A track's details, as Spotify has them, looked up once. */
async function details(id) {
  let kept = storage.get(`t:${id}`);
  if (!kept) {
    const track = await sp(`/metadata/4/track/${gid(id)}?market=from_token`);
    if (!track?.name || !track.album?.gid) throw new Error(`Spotify's answer for track ${id} has no name or album`);
    const albumArtist = track.album.artist?.[0] ?? track.artist?.[0] ?? {};
    kept = {
      title: track.name, artists: (track.artist ?? []).map((artist) => artist.name).filter(Boolean),
      disc: track.disc_number || 1, track: track.number || undefined, duration_ms: track.duration,
      isrc: (track.external_id ?? []).find((one) => one.type === "isrc")?.id,
      album: {
        id: idOf(track.album.gid), title: track.album.name, artist: albumArtist.name ?? "Unknown Artist",
        artist_gid: albumArtist.gid, date: dated(track.album.date), cover: cover(track.album.cover_group),
      },
    };
    storage.set(`t:${id}`, kept);
  }
  return kept;
}

/** An artist's picture, looked up once; "" for one Spotify has none of. */
async function portrait(artistGid) {
  if (!artistGid) return undefined;
  let kept = storage.get(`ar:${artistGid}`);
  if (kept === undefined) {
    try {
      kept = cover((await sp(`/metadata/4/artist/${artistGid}?market=from_token`))?.portrait_group) ?? "";
    } catch (error) {
      if (/^SIGN_IN_REQUIRED/.test(error.message)) throw error;
      console.warn(`an artist's picture: ${error.message}`);
      return undefined;
    }
    storage.set(`ar:${artistGid}`, kept);
  }
  return kept || undefined;
}

/** What ffprobe reads of YouTube's AAC file, from what the YouTube addon read off the player answer. */
function probe(audio) {
  const duration = (audio.duration_ms / 1000).toFixed(6);
  return {
    format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", nb_streams: 1, duration, size: String(audio.size), bit_rate: String(audio.bitrate) },
    streams: [{
      index: 0, codec_type: "audio", codec_name: "aac", profile: "LC", codec_tag_string: "mp4a",
      sample_rate: String(audio.sample_rate), channels: audio.channels, channel_layout: audio.channels === 1 ? "mono" : "stereo",
      duration, bit_rate: String(audio.bitrate), disposition: { default: 1 },
    }],
  };
}

// What the YouTube addon throws when it cannot be asked at all: the sync fails with it, as it says
// what to do. Anything else stops the looking for this sync.
const UNREACHABLE = /^(the addon youtube is not installed|YouTube is disabled|sign in to YouTube|YouTube exports no)/;

function settings(config) {
  return {
    liked: config.liked !== false, playlists: config.playlists !== false, albums: config.albums !== false,
    budget: Math.max(0, Math.min(500, Math.floor(Number(config.matches_per_sync ?? 30)))),
  };
}

/** @type {Addon} */
export default {
  async items(ctx) {
    // Signed in by this version, or else (1.x's pairing) asked to sign in again; the titles stay.
    await accessToken();
    const user = storage.get("tokens").user;
    const wanted = settings(ctx.config);

    // The library: each list's tracks in Spotify's order.
    const lists = [];
    let albums = [];
    if (wanted.liked || wanted.albums) {
      const saved = await collection(user);
      if (wanted.liked) lists.push({ title: LIKED, tracks: saved.liked });
      if (wanted.albums) albums = saved.albums;
    }
    const titles = new Set([LIKED]);
    const listed = wanted.playlists ? await playlists(user) : [];
    if (wanted.playlists) {
      for (const playlist of listed) {
        const listed = await playlistTracks(playlist);
        if (!listed) continue;
        let title = listed.title || "Untitled playlist";
        for (let n = 2; titles.has(title); n++) title = `${listed.title || "Untitled playlist"} (${n})`;
        titles.add(title);
        lists.push({ title, tracks: listed.tracks, id: playlist.id });
      }
    }
    const fromAlbums = [];
    for (const album of albums) fromAlbums.push(...(await albumTracks(album)));

    // Each track once, with its place in every playlist it is in.
    const places = new Map();
    for (const list of lists) {
      list.tracks.forEach((id, at) => {
        if (!places.has(id)) places.set(id, {});
        places.get(id)[list.title] ??= at + 1;
      });
    }
    for (const id of fromAlbums) if (!places.has(id)) places.set(id, {});
    console.log(`library: ${places.size} tracks (${lists.length} playlists with Liked Songs, ${albums.length} saved albums)`);

    // Look for the new ones on YouTube, a bounded number a sync.
    let looked = 0, waiting = 0, stopped = null;
    for (const id of places.keys()) {
      const match = storage.get(`m:${id}`);
      if (match && (!match.none || match.until > Date.now())) continue;
      if (looked >= wanted.budget || stopped) {
        waiting += 1;
        continue;
      }
      if (looked++) await sleep(MATCH_PAUSE_MS);
      let track;
      try {
        track = await details(id);
      } catch (error) {
        // A track Spotify no longer has: as one YouTube has none of.
        if (!/answered 404/.test(error.message)) throw error;
        storage.set(`m:${id}`, { none: true, until: Date.now() + RETRY_MS });
        continue;
      }
      let found;
      try {
        found = await addons.call("youtube", "findSong", {
          title: track.title, artists: track.artists, album: track.album.title, duration_ms: track.duration_ms, isrc: track.isrc,
        });
      } catch (error) {
        if (UNREACHABLE.test(error.message)) throw error;
        console.warn(`looking on YouTube stopped for this sync: ${error.message}`);
        stopped = error.message;
        waiting += 1;
        continue;
      }
      if (!found) {
        storage.set(`m:${id}`, { none: true, until: Date.now() + RETRY_MS });
        continue;
      }
      const { video_id, duration_ms, size, bitrate, sample_rate, channels, kind, score, via } = found;
      storage.set(`m:${id}`, { video_id, duration_ms, size, bitrate, sample_rate, channels, kind, score, via });
    }

    // What reached rex: every matched track.
    const items = [];
    let unmatched = 0;
    for (const [id, playlists] of places) {
      const match = storage.get(`m:${id}`);
      if (!match?.video_id) {
        if (match?.none) unmatched += 1;
        continue;
      }
      const track = await details(id);
      const poster = await portrait(track.album.artist_gid);
      items.push({
        id: `sp-${id}`,
        path: `spotify/${track.album.id}/${id}.m4a`,
        kind: "track", disc: track.disc, ...(track.track ? { track: track.track } : {}),
        size: match.size,
        display: {
          title: track.title, date: track.album.date,
          artist: { title: track.album.artist, ...(poster ? { poster } : {}) },
          album: { title: track.album.title, date: track.album.date, ...(track.album.cover ? { poster: track.album.cover } : {}) },
        },
        playlists,
        media_info: probe(match),
      });
    }
    console.log(`${items.length} matched, ${unmatched} not on YouTube (looked for again after a week), ${waiting} waiting; ${looked} looked for this sync`);

    // Forget what left the library, so storage stays bounded.
    const albumsKept = new Set(albums), playlistsKept = new Set(listed.map((playlist) => playlist.id));
    for (const id of storage.get("known") ?? []) {
      if (!places.has(id)) ["t", "m"].forEach((kind) => storage.delete(`${kind}:${id}`));
    }
    for (const id of storage.get("albums") ?? []) if (!albumsKept.has(id)) storage.delete(`al:${id}`);
    for (const id of storage.get("playlists") ?? []) if (!playlistsKept.has(id)) storage.delete(`pl:${id}`);
    const artists = new Set([...places.keys()].map((id) => storage.get(`t:${id}`)?.album?.artist_gid).filter(Boolean));
    for (const artist of storage.get("artists") ?? []) if (!artists.has(artist)) storage.delete(`ar:${artist}`);
    // The lists as read, in Spotify's order (what a test compares rex's playlists with).
    storage.set("lists", lists.map((list) => ({ title: list.title, tracks: list.tracks })));
    storage.set("known", [...places.keys()]);
    storage.set("albums", [...albumsKept]);
    storage.set("playlists", [...playlistsKept]);
    storage.set("artists", [...artists]);
    return items;
  },

  async open(id) {
    const match = storage.get(`m:${id.replace(/^sp-/, "")}`);
    if (!match?.video_id) throw new Error(`${id} has no recording on YouTube`);
    // A fresh link for each play: YouTube's last six hours.
    const audio = await addons.call("youtube", "songAudio", match.video_id);
    return { url: audio.url };
  },

  async signIn() {
    storage.delete("poll");
    const answer = await account("/oauth2/device/authorize", { scope: SCOPES });
    if (answer.error || !answer.device_code) throw new Error(`Spotify refused to start a sign-in: ${answer.error_description ?? answer.error ?? answer.status}`);
    return {
      code: answer.user_code, url: answer.verification_uri, expires_in: answer.expires_in, interval: answer.interval ?? 5,
      state: { device_code: answer.device_code },
    };
  },

  async signInPoll(state) {
    // After a slow_down, polls come 5 s further apart for the rest of the sign-in (RFC 8628); the
    // host keeps polling at the first interval, so the ones in between ask nothing.
    const poll = storage.get("poll") ?? { every: 0, next: 0 };
    if (Date.now() < poll.next) return { done: false };
    let answer;
    try {
      answer = await account("/api/token", { grant_type: DEVICE_GRANT, device_code: state.device_code });
    } catch (error) {
      if (!/^RETRY_AFTER/.test(error.message)) throw error;
      answer = { error: "slow_down" };
    }
    if (answer.error === "slow_down") {
      storage.set("poll", { every: poll.every + 5000, next: Date.now() + poll.every + 5000 });
      return { done: false };
    }
    if (answer.error === "authorization_pending") {
      if (poll.every) storage.set("poll", { ...poll, next: Date.now() + poll.every });
      return { done: false };
    }
    if (answer.error === "access_denied") throw new Error("the sign-in was refused on Spotify");
    if (answer.error === "expired_token") throw new Error("the code expired before it was entered");
    if (answer.error || !answer.access_token || !answer.refresh_token) throw new Error(`Spotify refused the sign-in: ${answer.error_description ?? answer.error ?? answer.status}`);
    if (!answer.username) throw new Error("Spotify signed in but did not say which account");
    storage.delete("poll");
    keep(answer);
    let name = answer.username;
    try {
      name = (await sp(`/user-profile-view/v3/profile/${encodeURIComponent(answer.username)}`))?.name || name;
    } catch (error) {
      console.warn(`the account's name: ${error.message.split("\n")[0]}`);
    }
    return { done: true, account: name };
  },

  async signOut() {
    // Spotify has no endpoint to revoke a token, so signing out forgets them here.
    storage.delete("tokens");
    storage.delete("poll");
  },
};

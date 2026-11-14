# rex-community-addons

More addons for [rex-addons](https://github.com/debridmediamanager/rex-addons), which brings things
into [rex](https://rex.debridmediamanager.com) and so into every Plex app. They run wherever
rex-addons runs: [rex for Android](https://notes.debridmediamanager.com/rex/android/),
[zurg+rex](https://notes.debridmediamanager.com/zurg/guides/android/), or beside rex on a computer.

## Add this repository

In the app, under **Addons**, add the repository `github.com/debridmediamanager/rex-community-addons`,
then install the addons you want from its list.

These addons used to be in rex-addons. If you installed one from there, it keeps working. Add this
repository and it shows an update; installing that moves the addon here, with your settings, sign-in
and titles kept. If it shows as Installed with no update, the app is too old to move it: update the
app, or remove the addon and install it from here.

## Addons in this repository

| Addon | What it brings |
|---|---|
| Stremio addons | Films and series from your Stremio addons' catalogs, played from your stream addons' links |
| YouTube | Your YouTube playlists (Liked videos, Watch later, your own) and any playlist you link, each a playlist in Plex, played from YouTube up to 1080p |
| Spotify | Your Spotify library (Liked Songs, your playlists, saved albums) as music in Plexamp and the Plex apps, each song played as its recording on YouTube |

## Stremio addons

Paste your Stremio addons' manifest links in the addon's settings: catalog addons (such as
Cinemeta) give the films and series, stream addons give what plays. Each title goes to rex with its
IMDb id, so Plex names it, and plays from the best stream your stream addons give at that moment.
Settings choose the catalogs, how many titles each, the highest resolution and the largest file.
Links that carry account keys are hidden in the app once saved.

## YouTube

Sign in, and your Liked videos, Watch later and your own playlists show up in a library called
YouTube: each channel is a show, each video one of its episodes with YouTube's title, date and
picture. Each YouTube playlist is a playlist in Plex, in YouTube's order. A video in several
playlists is there once. Links to anyone's public or unlisted playlists go in the settings, as do
how many videos to take from each playlist (the first ones in its order, which for Liked videos
are the newest; 200 by default) and which of yours to take.

- **Signing in is required.** The app shows a code; enter it at google.com/device on your phone.
  It is YouTube's TV sign-in, and the addon talks to YouTube as YouTube's TV app does. Signing out
  in the app revokes it.
- **Up to 1080p.** A video plays from YouTube's H.264 picture and AAC sound, which every Plex app
  plays; YouTube keeps them as two files, and rex joins them as it plays without converting
  either, so rex needs FFmpeg ([rex's setup](https://github.com/debridmediamanager/rex/blob/main/docs/setup.md#transcoding)).
  The highest quality is a setting: 1080 (the default), 720, 480 or 360. At 360, and for a video
  without that pair, it plays YouTube's 360p MP4 as it is. Changing the setting checks every video
  again, a sync's worth at a time.
- **Nothing is downloaded.** rex reads the files from YouTube when you press play. To make YouTube's
  links work, the addon fetches YouTube's player script (about 2.5 MB) when YouTube changes it and
  keeps the small part of it that unlocks a link. Each video is checked once (one request to
  YouTube for its files, then up to a few hundred KB of them) before it shows; a sync checks up to
  30, an hour apart, so a long list fills in over a few hours. Playlists are read again every six
  hours.
- **Limits:** private, deleted, members-only and live videos are left out. No descriptions: YouTube's
  TV app is not given them. A video's links last six hours, so each play asks YouTube for fresh ones.

## Spotify

Your Spotify library becomes music in Plexamp and every Plex app, in a music library called
Spotify: Liked Songs, your playlists (and those you follow) and your saved albums, each song
with Spotify's title, album, artist, track number, release date and cover, under its album and its
album's artist. Each Spotify playlist, and Liked Songs, is a playlist in Plex in Spotify's order. A
song in several playlists is there once.

- **The sound comes from YouTube.** Spotify doesn't let apps like this one play its music, so each
  song plays as its recording on YouTube, through the YouTube addon: YouTube Music's own recording
  of it where YouTube has one, else an upload of it at the same length. Now and
  then that is another version than Spotify's (another master, a single edit, an upload with a few
  seconds more), and a song YouTube has no recording of at its length is left out. On a library of
  38 songs we checked, 36 were found, 24 of them YouTube Music's own recordings. Plex apps play the
  sound as it is (AAC, about 128 kbit/s); nothing is downloaded until you play it.
- **The YouTube addon is needed, signed in.** The Spotify addon asks it to find each song and to
  play it, with its YouTube sign-in. Install it and sign in first; the app says when it isn't ready.
- **Signing in:** press Sign in to Spotify, then enter the code the app shows at spotify.com/pair,
  on any phone or computer. No password is typed on the TV, and the addon only reads your
  library. Updating from version 1 asks you to sign in this way once; your music stays.
- **A few songs at a time.** A song is looked for on YouTube once, before it shows: a sync looks for
  30 (a setting), an hour apart, so a big library fills in over a day or two. A song YouTube has
  none of is looked for again a week later. Playlists are read again when Spotify says they changed.
- **Limits:** no podcasts and no local files; artists are shown by Spotify's names and pictures,
  not Plex's, so there are no artist bios or similar artists; a song shows
  under its album's first artist; lyrics aren't brought. Playlists you follow that went private are
  left out.

## Writing addons

How addons work, and the `types/` folder these use (a copy of rex-addons' own):
[writing addons](https://github.com/debridmediamanager/rex-addons/blob/main/docs/writing-addons.md).

## License

MIT

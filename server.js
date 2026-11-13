require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const { promisify } = require('util');
const NodeID3 = require('node-id3');
const fs = require('fs');
const path = require('path');
const os = require('os');

const execFileAsync = promisify(execFile);
const app = express();
app.use(cors());
app.use(express.json());

function sanitizeFileName(name) {
  return name.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim();
}

async function getPublicPlaylistTracks(playlistId) {
  const embedUrl = `https://open.spotify.com/embed/playlist/${playlistId}`;
  const response = await fetch(embedUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  });

  if (!response.ok) {
    throw new Error(`Spotify sayfasına erişilemedi (Durum: ${response.status}).`);
  }

  const html = await response.text();
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  
  if (!match || !match[1]) {
    throw new Error('Çalma listesi verileri okunamadı.');
  }

  const jsonData = JSON.parse(match[1]);
  const entity = jsonData?.props?.pageProps?.state?.data?.entity;

  if (!entity || !entity.trackList) {
    throw new Error('Çalma listesi boş veya gizli.');
  }

  const playlistName = sanitizeFileName(entity.name || entity.title || 'Spotify_Playlist');
  const playlistCover = entity.visualIdentity?.image?.[0]?.url || entity.coverArt?.sources?.[0]?.url || '';
  
  const tracks = entity.trackList.map(track => {
    const trackId = track.uri && track.uri.includes(':') ? track.uri.split(':').pop() : '';
    return {
      name: track.title,
      artist: (track.subtitle || 'Bilinmeyen Sanatçı').replace(/\u00a0/g, ' '),
      trackId
    };
  });

  return { playlistName, playlistCover, tracks };
}

async function getTrackCoverBuffer(trackId, fallbackCover) {
  let coverUrl = fallbackCover || '';
  try {
    if (trackId) {
      const oembedRes = await fetch(`https://open.spotify.com/oembed?url=https://open.spotify.com/track/${trackId}`);
      if (oembedRes.ok) {
        const oembedData = await oembedRes.json();
        if (oembedData.thumbnail_url) {
          coverUrl = oembedData.thumbnail_url;
        }
      }
    }
    if (!coverUrl) return null;

    const imgRes = await fetch(coverUrl);
    if (!imgRes.ok) return null;
    const arrayBuffer = await imgRes.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    return null;
  }
}

// Bulut IP engelini aşmak için Piped API üzerinden YouTube ses akışı çekme
async function downloadViaPiped(query, finalMp3Path) {
  const pipedInstances = [
    'https://pipedapi.kavin.rocks',
    'https://pipedapi.adminforge.de',
    'https://pipedapi.leptons.xyz',
    'https://api.piped.private.coffee'
  ];

  for (const instance of pipedInstances) {
    try {
      const searchRes = await fetch(`${instance}/search?q=${encodeURIComponent(query)}&filter=music_songs`, {
        signal: AbortSignal.timeout(8000)
      });
      if (!searchRes.ok) continue;

      const searchData = await searchRes.json();
      const firstItem = searchData?.items?.[0];
      if (!firstItem || !firstItem.url) continue;

      const videoId = firstItem.url.split('v=')[1]?.split('&')[0];
      if (!videoId) continue;

      const streamRes = await fetch(`${instance}/streams/${videoId}`, {
        signal: AbortSignal.timeout(10000)
      });
      if (!streamRes.ok) continue;

      const streamData = await streamRes.json();
      const audioStreams = streamData?.audioStreams || [];
      if (audioStreams.length === 0) continue;

      // En yüksek bit hızına sahip ses akışını seç
      audioStreams.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      const bestAudioUrl = audioStreams[0].url;
      if (!bestAudioUrl) continue;

      // FFmpeg ile doğrudan MP3'e dönüştür
      await execFileAsync('ffmpeg', [
        '-y',
        '-i', bestAudioUrl,
        '-vn',
        '-ab', '192k',
        '-ar', '44100',
        finalMp3Path
      ], { timeout: 45000 });

      if (fs.existsSync(finalMp3Path) && fs.statSync(finalMp3Path).size > 10000) {
        return true;
      }
    } catch (e) {
      // Sıradaki sunucuyu dene
    }
  }
  return false;
}

// Yedek yöntem: Sistemdeki güncel yt-dlp (varsa çerez ile)
async function downloadViaYtDlp(query, tempBase) {
  const args = [
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', '0',
    '-o', `${tempBase}.%(ext)s`,
    '--no-check-certificates',
    '--no-warnings',
    '--force-ipv4'
  ];

  if (process.env.YT_COOKIES) {
    const cookiePath = path.join(os.tmpdir(), 'yt_cookies.txt');
    fs.writeFileSync(cookiePath, process.env.YT_COOKIES, 'utf8');
    args.push('--cookies', cookiePath);
  }

  args.push(query);
  await execFileAsync('/usr/local/bin/yt-dlp', args, { timeout: 45000 });
}

app.get('/playlist', async (req, res) => {
  const playlistId = req.query.id;
  if (!playlistId) return res.status(400).json({ error: 'Playlist ID gerekli' });

  try {
    const data = await getPublicPlaylistTracks(playlistId);
    console.log(`\nListe okundu: "${data.playlistName}" (${data.tracks.length} şarkı)`);
    res.json(data);
  } catch (error) {
    console.error('Liste okuma hatası:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/download-track', async (req, res) => {
  const { artist, name, album, trackId, fallbackCover } = req.query;
  if (!artist || !name) return res.status(400).json({ error: 'Sanatçı ve şarkı adı gerekli' });

  const safeFileName = sanitizeFileName(`${artist} - ${name}`);
  const tempBase = path.join(os.tmpdir(), `sp_${Date.now()}_${Math.floor(Math.random() * 10000)}`);
  const finalMp3Path = `${tempBase}.mp3`;

  const cleanup = () => {
    if (fs.existsSync(finalMp3Path)) {
      fs.unlink(finalMp3Path, () => {});
    }
  };

  try {
    console.log(`İndiriliyor: ${safeFileName}`);
    const cleanArtist = artist.split(',')[0].trim();
    const cleanName = name.replace(/\(.*?\)|\[.*?\]/g, '').trim();

    // 1. Önce bulut IP engelini aşan Piped API üzerinden dene
    let downloaded = await downloadViaPiped(`${cleanArtist} ${cleanName}`, finalMp3Path);

    // 2. Bulunamazsa sistemdeki güncel yt-dlp ile dene
    if (!downloaded) {
      console.log(`  -> Piped yanıt vermedi, yt-dlp deneniyor: ${safeFileName}`);
      await downloadViaYtDlp(`ytsearch1:${cleanArtist} ${cleanName} audio`, tempBase);
    }

    if (!fs.existsSync(finalMp3Path)) {
      throw new Error('MP3 dosyası oluşturulamadı');
    }

    const coverBuffer = await getTrackCoverBuffer(trackId, fallbackCover);
    const tags = {
      title: name,
      artist: artist,
      album: album || 'Spotify Playlist'
    };

    if (coverBuffer) {
      tags.image = {
        mime: 'image/jpeg',
        type: { id: 3, name: 'front cover' },
        description: 'Cover',
        imageBuffer: coverBuffer
      };
    }

    NodeID3.write(tags, finalMp3Path);

    const asciiFallback = safeFileName.replace(/[^\x20-\x7E]/g, '_');
    const encodedName = encodeURIComponent(`${safeFileName}.mp3`);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${asciiFallback}.mp3"; filename*=UTF-8''${encodedName}`);

    res.on('finish', cleanup);
    res.on('close', cleanup);

    const fileStream = fs.createReadStream(finalMp3Path);
    fileStream.on('error', () => {
      cleanup();
      if (!res.headersSent) res.status(500).end();
    });
    fileStream.pipe(res);

  } catch (error) {
    cleanup();
    console.warn(`  -> ATLANDI (${safeFileName}):`, error.stderr || error.message);
    if (!res.headersSent) {
      res.status(404).json({ error: 'Şarkı bulunamadı' });
    }
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Sunucu çalışıyor: http://localhost:${process.env.PORT || 3000}`);
});

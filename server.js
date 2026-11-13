require('dotenv').config();
const express = require('express');
const cors = require('cors');
const youtubedl = require('yt-dlp-exec');
const NodeID3 = require('node-id3');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(cors());
app.use(express.json());

function sanitizeFileName(name) {
  return name.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim();
}

// Spotify embed sayfasından şarkı listesini ve parça kimliklerini çekme
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

// Spotify oEmbed üzerinden şarkının yüksek çözünürlüklü albüm kapağını indirme
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

// 1. Endpoint: Şarkı listesini ön yüze gönderir
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

// 2. Endpoint: Şarkıyı MP3 yapar, albüm kapağı ile ID3 etiketlerini gömer ve indirir
app.get('/download-track', async (req, res) => {
  const { artist, name, album, trackId, fallbackCover } = req.query;
  if (!artist || !name) return res.status(400).json({ error: 'Sanatçı ve şarkı adı gerekli' });

  const safeFileName = sanitizeFileName(`${artist} - ${name}`);
  const tempBase = path.join(os.tmpdir(), `sp_${Date.now()}_${Math.floor(Math.random() * 10000)}`);
  const finalMp3Path = `${tempBase}.mp3`;

  const ytOptions = {
    extractAudio: true,
    audioFormat: 'mp3',
    audioQuality: 0,
    output: `${tempBase}.%(ext)s`,
    noCheckCertificates: true,
    noWarnings: true,
  };

  const cleanup = () => {
    if (fs.existsSync(finalMp3Path)) {
      fs.unlink(finalMp3Path, () => {});
    }
  };

  try {
    console.log(`İndiriliyor ve etiketleniyor: ${safeFileName}`);
    try {
      await youtubedl(`ytsearch1:${artist} ${name} audio`, ytOptions);
    } catch (firstErr) {
      const cleanArtist = artist.split(',')[0].trim();
      const cleanName = name.replace(/\(.*?\)|\[.*?\]/g, '').trim();
      console.log(`  -> Alternatif arama: ${cleanArtist} - ${cleanName}`);
      await youtubedl(`ytsearch1:${cleanArtist} ${cleanName} official audio`, ytOptions);
    }

    if (!fs.existsSync(finalMp3Path)) {
      throw new Error('MP3 dosyası oluşturulamadı');
    }

    // Albüm kapağını çek ve ID3 meta verilerini MP3 dosyasına işle
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
    console.warn(`  -> ATLANDI: ${safeFileName}`);
    if (!res.headersSent) {
      res.status(404).json({ error: 'Şarkı bulunamadı' });
    }
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Sunucu çalışıyor: http://localhost:${process.env.PORT || 3000}`);
});
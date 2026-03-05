const express = require('express');
const Parser = require('rss-parser');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const parser = new Parser({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*'
  },
  customFields: {
    item: [
      ['media:content', 'mediaContent'],
      ['media:thumbnail', 'mediaThumbnail'],
      ['enclosure', 'enclosure']
    ]
  }
});

let cachedArticles = [];
let lastFetch = 0;
const CACHE_TTL = 15 * 60 * 1000;

function extractImage(item) {
  if (item.mediaContent?.$?.url?.startsWith('http')) return item.mediaContent.$.url;
  if (item.mediaThumbnail?.$?.url?.startsWith('http')) return item.mediaThumbnail.$.url;
  if (item.enclosure?.url?.startsWith('http')) return item.enclosure.url;
  const content = item['content:encoded'] || item.content || item.description || '';
  const imgMatch = content.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch?.[1]?.startsWith('http')) return imgMatch[1];
  const urlMatch = content.match(/https?:\/\/[^\s"'<>]+\.(?:jpg|jpeg|png|webp)(?:[?][^\s"'<>]*)?/i);
  if (urlMatch) return urlMatch[0];
  return null;
}

async function fetchOgImage(url) {
  try {
    const res = await fetch(url, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' } });
    const html = await res.text();
    const match = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    return match?.[1]?.startsWith('http') ? match[1] : null;
  } catch { return null; }
}

async function fetchViaRss2json(feedUrl, source, sourceName) {
  try {
    const apiUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feedUrl)}`;
    const res = await fetch(apiUrl, { timeout: 15000 });
    const text = await res.text();
    // Guard against HTML error responses
    if (!text.startsWith('{')) { console.error(`${sourceName} rss2json: non-JSON response`); return null; }
    const data = JSON.parse(text);
    if (data.status === 'ok' && data.items?.length) {
      console.log(`${sourceName} via rss2json: ${data.items.length} items`);
      return data.items.slice(0, 20).map(item => ({
        source, sourceName,
        title: item.title || '',
        description: item.description ? item.description.replace(/<[^>]+>/g, '').slice(0, 200) : '',
        link: item.link || '',
        date: item.pubDate || '',
        image: item.thumbnail || item.enclosure?.link || null
      }));
    }
    console.error(`${sourceName} rss2json:`, data.status, data.message);
  } catch (e) { console.error(`${sourceName} rss2json:`, e.message); }
  return null;
}

async function fetchDirectFeed(feedUrl, source, sourceName) {
  try {
    const res = await fetch(feedUrl, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSS reader)', 'Accept': 'application/rss+xml, text/xml, */*' }
    });
    if (!res.ok) { console.error(`${sourceName} direct: HTTP ${res.status}`); return null; }
    let xml = await res.text();
    // Sanitize invalid XML entities
    xml = xml.replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');
    const feed = await parser.parseString(xml);
    if (feed.items?.length) {
      console.log(`${sourceName} direct: ${feed.items.length} items`);
      return feed.items.slice(0, 20).map(item => ({
        source, sourceName,
        title: item.title || '',
        description: item.contentSnippet || '',
        link: item.link || '',
        date: item.pubDate || item.isoDate || '',
        image: extractImage(item)
      }));
    }
  } catch (e) { console.error(`${sourceName} direct:`, e.message); }
  return null;
}

async function fetchHypebeast() {
  // Try direct first, then rss2json as fallback
  const direct = await fetchDirectFeed('https://hypebeast.com/feed', 'hypebeast', 'Hypebeast');
  if (direct) {
    return direct.map(a => {
      if (!a.image) {
        // no-op, image already extracted
      }
      return { ...a, sourceName: 'Hypebeast' };
    });
  }
  const r2j = await fetchViaRss2json('https://hypebeast.com/feed', 'hypebeast', 'Hypebeast');
  if (r2j) return r2j;
  return [];
}

async function fetchHighsnobiety() {
  try {
    const feed = await parser.parseURL('https://www.highsnobiety.com/feed/');
    const articles = [];
    for (const item of feed.items.slice(0, 20)) {
      let image = extractImage(item);
      if (!image && item.link) image = await fetchOgImage(item.link);
      articles.push({ source: 'highsnobiety', sourceName: 'Highsnobiety', title: item.title || '', description: item.contentSnippet || '', link: item.link || '', date: item.pubDate || item.isoDate || '', image });
    }
    return articles;
  } catch (e) { console.error('Highsnobiety:', e.message); return []; }
}

async function fetchSneakerNews() {
  const r2j = await fetchViaRss2json('https://sneakernews.com/feed/', 'sneakernews', 'Sneaker News');
  if (r2j) return r2j;
  const direct = await fetchDirectFeed('https://sneakernews.com/feed/', 'sneakernews', 'Sneaker News');
  return direct || [];
}

async function fetchHipHopDX() {
  try {
    const res = await fetch('https://hiphopdx.com/rss/news.xml', {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSS reader)', 'Accept': 'application/rss+xml, text/xml, */*' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let xml = await res.text();
    xml = xml.replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');
    const feed = await parser.parseString(xml);
    if (feed.items?.length) {
      console.log(`HipHopDX: ${feed.items.length} items`);
      const articles = [];
      for (const item of feed.items.slice(0, 20)) {
        let image = extractImage(item);
        if (!image && item.link) image = await fetchOgImage(item.link);
        articles.push({ source: 'hiphopdx', sourceName: 'HipHopDX', title: item.title || '', description: item.contentSnippet || '', link: item.link || '', date: item.pubDate || item.isoDate || '', image });
      }
      return articles;
    }
  } catch (e) { console.error('HipHopDX:', e.message); }
  return [];
}


async function fetchPause() {
  try {
    const res = await fetch('https://pausemag.co.uk/feed/', {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSS reader)', 'Accept': 'application/rss+xml, text/xml, */*' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let xml = await res.text();
    // Wrap CDATA around content:encoded and description to prevent XML parse errors
    xml = xml.replace(/<content:encoded>(?!<!\[CDATA\[)([\s\S]*?)<\/content:encoded>/gi, (m, inner) => `<content:encoded><![CDATA[${inner}]]></content:encoded>`);
    xml = xml.replace(/<description>(?!<!\[CDATA\[)([\s\S]*?)<\/description>/gi, (m, inner) => `<description><![CDATA[${inner}]]></description>`);
    xml = xml.replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');
    const feed = await parser.parseString(xml);
    const articles = [];
    for (const item of feed.items.slice(0, 20)) {
      let image = extractImage(item);
      if (!image && item.link) image = await fetchOgImage(item.link);
      articles.push({ source: 'pause', sourceName: 'PAUSE', title: item.title || '', description: item.contentSnippet || '', link: item.link || '', date: item.pubDate || item.isoDate || '', image });
    }
    console.log(`PAUSE: ${articles.length} items`);
    return articles;
  } catch (e) { console.error('PAUSE:', e.message); return []; }
}

async function fetchAllFeeds() {
  console.log('Fetching all feeds...');
  try {
    const [hypebeast, highsnobiety, sneakernews, hiphopdx, pause] = await Promise.allSettled([
      fetchHypebeast(), fetchHighsnobiety(), fetchSneakerNews(), fetchHipHopDX(), fetchPause()
    ]);
    const articles = [
      ...(hypebeast.status === 'fulfilled' ? hypebeast.value : []),
      ...(highsnobiety.status === 'fulfilled' ? highsnobiety.value : []),
      ...(sneakernews.status === 'fulfilled' ? sneakernews.value : []),
      ...(hiphopdx.status === 'fulfilled' ? hiphopdx.value : []),
      ...(pause.status === 'fulfilled' ? pause.value : [])
    ];
    articles.sort((a, b) => new Date(b.date) - new Date(a.date));
    cachedArticles = articles;
    lastFetch = Date.now();
    console.log(`Fetched ${articles.length} articles total`);
    return articles;
  } catch (e) { console.error('fetchAllFeeds:', e); return cachedArticles; }
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/articles', async (req, res) => {
  try {
    if (cachedArticles.length === 0 || Date.now() - lastFetch > CACHE_TTL) await fetchAllFeeds();
    res.json({ articles: cachedArticles, lastFetch });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/refresh', async (req, res) => {
  lastFetch = 0;
  await fetchAllFeeds();
  res.json({ articles: cachedArticles, lastFetch });
});

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

app.listen(PORT, async () => {
  console.log(`Feed aggregator running on port ${PORT}`);
  fetchAllFeeds().catch(console.error);
});

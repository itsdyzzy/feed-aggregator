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

async function fetchHypebeast() {
  try {
    const apiUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent('https://hypebeast.com/feed')}`;
    const res = await fetch(apiUrl, { timeout: 15000 });
    const data = await res.json();
    if (data.status === 'ok' && data.items?.length) {
      console.log(`Hypebeast via rss2json: ${data.items.length} items`);
      return data.items.slice(0, 20).map(item => ({
        source: 'hypebeast',
        sourceName: 'Hypebeast',
        title: item.title || '',
        description: item.description ? item.description.replace(/<[^>]+>/g, '').slice(0, 200) : '',
        link: item.link || '',
        date: item.pubDate || '',
        image: item.thumbnail || item.enclosure?.link || null
      }));
    }
  } catch (e) { console.error('Hypebeast rss2json:', e.message); }

  try {
    const res = await fetch('https://hypebeast.com/feed', {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSS reader)', 'Accept': 'application/rss+xml, text/xml, */*' }
    });
    if (res.ok) {
      const xml = await res.text();
      const feed = await parser.parseString(xml);
      if (feed.items?.length) {
        console.log(`Hypebeast direct: ${feed.items.length} items`);
        return feed.items.slice(0, 20).map(item => {
          let image = extractImage(item);
          if (!image) {
            const c = item['content:encoded'] || '';
            const m = c.match(/https?:\/\/image-cdn\.hypb\.st[^\s"'<>]+/i);
            if (m) image = m[0];
          }
          return { source: 'hypebeast', sourceName: 'Hypebeast', title: item.title || '', description: item.contentSnippet || '', link: item.link || '', date: item.pubDate || item.isoDate || '', image };
        });
      }
    }
  } catch (e) { console.error('Hypebeast direct:', e.message); }

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

async function fetchModernNotoriety() {
  try {
    const feed = await parser.parseURL('https://modernnotoriety.com/feed/');
    const articles = [];
    for (const item of feed.items.slice(0, 20)) {
      let image = extractImage(item);
      if (!image && item.link) image = await fetchOgImage(item.link);
      articles.push({ source: 'modernnotoriety', sourceName: 'Modern Notoriety', title: item.title || '', description: item.contentSnippet || '', link: item.link || '', date: item.pubDate || item.isoDate || '', image });
    }
    console.log(`Modern Notoriety: ${articles.length} items`);
    return articles;
  } catch (e) { console.error('Modern Notoriety:', e.message); return []; }
}

async function fetchAllFeeds() {
  console.log('Fetching all feeds...');
  try {
    const [hypebeast, highsnobiety, modernnotoriety] = await Promise.allSettled([
      fetchHypebeast(),
      fetchHighsnobiety(),
      fetchModernNotoriety()
    ]);
    const articles = [
      ...(hypebeast.status === 'fulfilled' ? hypebeast.value : []),
      ...(highsnobiety.status === 'fulfilled' ? highsnobiety.value : []),
      ...(modernnotoriety.status === 'fulfilled' ? modernnotoriety.value : [])
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

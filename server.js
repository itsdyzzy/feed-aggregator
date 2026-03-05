const express = require('express');
const Parser = require('rss-parser');
const fetch = require('node-fetch');
const path = require('path');
const { chromium } = require('playwright');

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
let lastComplexFetch = 0;
let cachedComplexArticles = [];
const CACHE_TTL = 15 * 60 * 1000;         // 15 mins for Hypebeast/Highsnobiety
const COMPLEX_CACHE_TTL = 90 * 60 * 1000; // 90 mins for Complex

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
  const feedUrls = ['https://hypebeast.com/feed', 'https://hypebeast.com/feed/'];
  for (const feedUrl of feedUrls) {
    try {
      const res = await fetch(feedUrl, {
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSS reader)', 'Accept': 'application/rss+xml, text/xml, */*' }
      });
      if (!res.ok) continue;
      const xml = await res.text();
      if (!xml || xml.length < 200) continue;
      const feed = await parser.parseString(xml);
      if (!feed.items?.length) continue;
      console.log(`Hypebeast: ${feed.items.length} items`);
      return feed.items.slice(0, 20).map(item => {
        let image = extractImage(item);
        if (!image) {
          const c = item['content:encoded'] || '';
          const m = c.match(/https?:\/\/image-cdn\.hypb\.st[^\s"'<>]+/i);
          if (m) image = m[0];
        }
        return { source: 'hypebeast', sourceName: 'Hypebeast', title: item.title || '', description: item.contentSnippet || '', link: item.link || '', date: item.pubDate || item.isoDate || '', image };
      });
    } catch (e) { console.error(`Hypebeast (${feedUrl}):`, e.message); }
  }
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

async function fetchComplex() {
  // Use cache if fresh enough
  if (cachedComplexArticles.length > 0 && Date.now() - lastComplexFetch < COMPLEX_CACHE_TTL) {
    console.log('Complex: using cache');
    return cachedComplexArticles;
  }

  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
    const articles = [];
    const seen = new Set();

    for (const url of ['https://www.complex.com/sneakers', 'https://www.complex.com/style']) {
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(3000);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
        await page.waitForTimeout(2000);

        const pageArticles = await page.evaluate(() => {
          const results = [];
          const links = [...document.querySelectorAll('a[href*="/a/"]')];
          for (const a of links) {
            const href = a.getAttribute('href');
            if (!href || href.startsWith('http') || href.includes('/sports/') || href.includes('/v/')) continue;
            const titleEl = a.querySelector('h1,h2,h3,h4,p') || a;
            let title = titleEl.textContent?.trim() || '';
            title = title.replace(/^(Sneakers|Style|Pop Culture|Music|Sports|Life|Rides|Tech)+/i, '').trim();
            if (!title || title.length < 10) continue;
            let imgSrc = null;
            let el = a;
            for (let i = 0; i < 6; i++) {
              const img = el.querySelector('img');
              if (img?.src?.startsWith('http')) { imgSrc = img.src; break; }
              el = el.parentElement;
              if (!el) break;
            }
            if (imgSrc) imgSrc = imgSrc.replace(/\/upload\/[^/]+\//, '/upload/q_auto,f_jpg,w_800,c_fill,ar_1.78,g_center/');
            results.push({ href: 'https://www.complex.com' + href, title, image: imgSrc });
          }
          return results;
        });

        for (const a of pageArticles) {
          if (seen.has(a.title)) continue;
          seen.add(a.title);
          articles.push({ source: 'complex', sourceName: 'Complex', title: a.title, description: '', link: a.href, date: new Date().toISOString(), image: a.image });
        }
      } catch (e) {
        console.error(`Complex page error (${url}):`, e.message);
      } finally {
        await page.close();
      }
    }

    const result = articles.slice(0, 20);
    if (result.length > 0) {
      cachedComplexArticles = result;
      lastComplexFetch = Date.now();
    }
    console.log(`Complex: ${result.length} articles`);
    return result;
  } catch (e) {
    console.error('Complex Playwright error:', e.message);
    return cachedComplexArticles; // return stale cache if available
  } finally {
    if (browser) await browser.close();
  }
}

async function fetchAllFeeds() {
  console.log('Fetching all feeds...');
  try {
    const [hypebeast, highsnobiety, complex] = await Promise.allSettled([fetchHypebeast(), fetchHighsnobiety(), fetchComplex()]);
    const articles = [
      ...(hypebeast.status === 'fulfilled' ? hypebeast.value : []),
      ...(highsnobiety.status === 'fulfilled' ? highsnobiety.value : []),
      ...(complex.status === 'fulfilled' ? complex.value : [])
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

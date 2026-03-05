const express = require('express');
const { chromium } = require('playwright');
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
  // Try rss2json first as it's more reliable for Hypebeast
  const r2j = await fetchViaRss2json('https://hypebeast.com/feed', 'hypebeast', 'Hypebeast');
  if (r2j && r2j.length > 0) return r2j;

  // Try direct with various user agents
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Googlebot/2.1 (+http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; RSS reader)'
  ];
  for (const ua of userAgents) {
    try {
      const res = await fetch('https://hypebeast.com/feed', {
        timeout: 15000,
        headers: { 'User-Agent': ua, 'Accept': 'application/rss+xml, text/xml, */*' }
      });
      if (!res.ok) continue;
      let xml = await res.text();
      if (!xml.includes('<rss') && !xml.includes('<feed')) continue;
      xml = xml.replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');
      const feed = await parser.parseString(xml);
      if (feed.items?.length) {
        console.log('Hypebeast direct: ' + feed.items.length + ' items');
        return feed.items.slice(0, 20).map(item => ({
          source: 'hypebeast', sourceName: 'Hypebeast',
          title: item.title || '', description: item.contentSnippet || '',
          link: item.link || '', date: item.pubDate || item.isoDate || '',
          image: extractImage(item)
        }));
      }
    } catch(e) { console.error('Hypebeast direct:', e.message); }
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

async function fetchSneakerNews() {
  try {
    const res = await fetch('https://sneakernews.com/feed/', {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSS reader)', 'Accept': 'application/rss+xml, text/xml, */*' }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    let xml = await res.text();
    xml = xml.replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');
    const feed = await parser.parseString(xml);
    const articles = [];
    for (const item of feed.items.slice(0, 20)) {
      let image = extractImage(item);
      if (!image && item.link) image = await fetchOgImage(item.link);
      articles.push({ source: 'sneakernews', sourceName: 'Sneaker News', title: item.title || '', description: item.contentSnippet || '', link: item.link || '', date: item.pubDate || item.isoDate || '', image });
    }
    console.log('Sneaker News: ' + articles.length + ' items');
    return articles;
  } catch (e) {
    console.error('Sneaker News direct:', e.message);
    const r2j = await fetchViaRss2json('https://sneakernews.com/feed/', 'sneakernews', 'Sneaker News');
    return r2j || [];
  }
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


// Generic Playwright scraper for JS-rendered sites
async function scrapeWithPlaywright(url, source, sourceName, scrapeLogic) {
  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    const articles = await scrapeLogic(page);
    console.log(sourceName + ' scraped: ' + articles.length + ' items');
    return articles;
  } catch (e) {
    console.error(sourceName + ' scrape error:', e.message);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

async function fetchComplex() {
  return scrapeWithPlaywright('https://www.complex.com/sneakers', 'complex', 'Complex', async (page) => {
    await page.waitForTimeout(3000);
    return page.evaluate(() => {
      const results = [];
      // Try all anchor tags that look like articles
      document.querySelectorAll('a[href]').forEach(a => {
        const href = a.href || '';
        if (!href.includes('complex.com') && !href.startsWith('/')) return;
        if (!href.includes('/sneakers/') && !href.match(/complex\.com\/[a-z-]+\/20\d\d/)) return;
        const img = a.querySelector('img');
        const textEls = a.querySelectorAll('h1,h2,h3,h4,[class*="title"],[class*="headline"],[class*="hed"]');
        const title = textEls.length ? textEls[0].innerText.trim() : a.innerText.trim().split('\n')[0].trim();
        if (!title || title.length < 10) return;
        results.push({
          source: 'complex', sourceName: 'Complex',
          title,
          description: '',
          link: href.startsWith('http') ? href : 'https://www.complex.com' + href,
          date: new Date().toISOString(),
          image: img ? (img.src || img.dataset.src || img.dataset.lazySrc) : null
        });
      });
      // Dedupe by title
      const seen = new Set();
      return results.filter(a => { if (seen.has(a.title)) return false; seen.add(a.title); return true; }).slice(0, 20);
    });
  });
}

async function fetchSoleRetriever() {
  return scrapeWithPlaywright('https://www.soleretriever.com/news', 'soleretriever', 'Sole Retriever', async (page) => {
    await page.waitForTimeout(3000);
    return page.evaluate(() => {
      const results = [];
      document.querySelectorAll('a[href]').forEach(a => {
        const href = a.href || '';
        if (!href.includes('soleretriever.com/news/')) return;
        const img = a.querySelector('img');
        const textEls = a.querySelectorAll('h1,h2,h3,h4,[class*="title"],[class*="headline"],[class*="heading"]');
        const title = textEls.length ? textEls[0].innerText.trim() : '';
        if (!title || title.length < 10) return;
        results.push({
          source: 'soleretriever', sourceName: 'Sole Retriever',
          title,
          description: '',
          link: href.startsWith('http') ? href : 'https://www.soleretriever.com' + href,
          date: new Date().toISOString(),
          image: img ? (img.src || img.dataset.src || img.dataset.lazySrc) : null
        });
      });
      const seen = new Set();
      return results.filter(a => { if (seen.has(a.title)) return false; seen.add(a.title); return true; }).slice(0, 20);
    });
  });
}

async function fetchHNHH() {
  return scrapeWithPlaywright('https://www.hotnewhiphop.com/articles/news', 'hnhh', 'HotNewHipHop', async (page) => {
    await page.waitForTimeout(3000);
    return page.evaluate(() => {
      const results = [];
      document.querySelectorAll('a[href]').forEach(a => {
        const href = a.href || '';
        if (!href.includes('hotnewhiphop.com') && !href.startsWith('/')) return;
        if (!href.match(/(news|articles)/)) return;
        const img = a.querySelector('img');
        const textEls = a.querySelectorAll('h1,h2,h3,h4,[class*="title"],[class*="headline"],[class*="name"]');
        const title = textEls.length ? textEls[0].innerText.trim() : a.innerText.trim().split('\n')[0].trim();
        if (!title || title.length < 10) return;
        results.push({
          source: 'hnhh', sourceName: 'HotNewHipHop',
          title,
          description: '',
          link: href.startsWith('http') ? href : 'https://www.hotnewhiphop.com' + href,
          date: new Date().toISOString(),
          image: img ? (img.src || img.dataset.src || img.dataset.lazySrc) : null
        });
      });
      const seen = new Set();
      return results.filter(a => { if (seen.has(a.title)) return false; seen.add(a.title); return true; }).slice(0, 20);
    });
  });
}


async function fetchAllFeeds() {
  console.log('Fetching all feeds...');
  try {
    const [hypebeast, highsnobiety, sneakernews, hiphopdx, complex, soleretriever, hnhh] = await Promise.allSettled([
      fetchHypebeast(), fetchHighsnobiety(), fetchSneakerNews(), fetchHipHopDX(), fetchComplex(), fetchSoleRetriever(), fetchHNHH()
    ]);
    const articles = [
      ...(hypebeast.status === 'fulfilled' ? hypebeast.value : []),
      ...(highsnobiety.status === 'fulfilled' ? highsnobiety.value : []),
      ...(sneakernews.status === 'fulfilled' ? sneakernews.value : []),
      ...(hiphopdx.status === 'fulfilled' ? hiphopdx.value : []),
      ...(complex.status === 'fulfilled' ? complex.value : []),
      ...(soleretriever.status === 'fulfilled' ? soleretriever.value : []),
      ...(hnhh.status === 'fulfilled' ? hnhh.value : [])
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

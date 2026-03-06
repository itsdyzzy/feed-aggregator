const express = require('express');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());
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
  const meta = await fetchOgMeta(url);
  return meta.image;
}

async function fetchOgMeta(url) {
  try {
    const res = await fetch(url, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' } });
    const html = await res.text();
    const imgMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                  || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    const image = imgMatch?.[1]?.startsWith('http') ? imgMatch[1] : null;
    // Try article:published_time, og:updated_time, datePublished in JSON-LD
    const dateMatch = html.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i)
                   || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time["']/i)
                   || html.match(/"datePublished"\s*:\s*"([^"]+)"/i)
                   || html.match(/"publishedAt"\s*:\s*"([^"]+)"/i);
    const date = dateMatch?.[1] || null;
    return { image, date };
  } catch { return { image: null, date: null }; }
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
  // Try rss2json first
  const r2j = await fetchViaRss2json('https://hypebeast.com/feed', 'hypebeast', 'Hypebeast');
  if (r2j && r2j.length > 0) return r2j;

  // Try direct RSS with multiple user agents
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Googlebot/2.1 (+http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; RSS reader)'
  ];
  for (const ua of userAgents) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      const res = await fetch('https://hypebeast.com/feed', {
        signal: controller.signal,
        headers: { 'User-Agent': ua, 'Accept': 'application/rss+xml, text/xml, */*' }
      });
      clearTimeout(timer);
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
    let articles = await scrapeLogic(page);
    // Fetch og:image and publish date for articles (in parallel, max 20)
    const needsMeta = articles.filter(a => !a.image || !a.date).slice(0, 20);
    if (needsMeta.length > 0) {
      await Promise.allSettled(needsMeta.map(async (article) => {
        const meta = await fetchOgMeta(article.link);
        if (meta.image && !article.image) article.image = meta.image;
        if (meta.date && !article.date) article.date = meta.date;
      }));
    }
    console.log(sourceName + ' scraped: ' + articles.length + ' items');
    return articles;
  } catch (e) {
    console.error(sourceName + ' scrape error:', e.message);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

// All three Playwright scrapers accept a shared browser instance.
// fetchAllFeeds launches ONE Chromium, passes it to each scraper in sequence,
// then closes it — preventing the OOM crashes from 3 simultaneous instances.

async function fetchComplex(browser) {
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({ 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });
    const allResults = [];
    for (const section of ['https://www.complex.com/sneakers', 'https://www.complex.com/style']) {
      try {
        await page.goto(section, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);
        const results = await page.evaluate(() => {
          const results = [];
          document.querySelectorAll('a[href]').forEach(a => {
            const href = a.href || '';
            if (!href.includes('complex.com')) return;
            if (!href.match(/complex\.com\/(sneakers|style|music|pop-culture|sports)\/[a-z0-9-]+\/[a-z0-9-]/)) return;
            const lines = a.innerText.trim().split('\n').map(l => l.trim()).filter(l => l.length > 15);
            const title = lines[0] || '';
            if (!title || title.length < 10) return;
            const card = a.closest('article,[class*="card"],[class*="item"],[class*="post"]');
            const timeEl = card ? card.querySelector('time') : null;
            results.push({ source: 'complex', sourceName: 'Complex', title, description: '', link: href, date: timeEl ? (timeEl.getAttribute('datetime') || '') : '', image: null });
          });
          const seen = new Set();
          return results.filter(a => { if (seen.has(a.title)) return false; seen.add(a.title); return true; });
        });
        allResults.push(...results);
      } catch(e) { console.error('Complex section error:', e.message); }
    }
    const seen = new Set();
    const deduped = allResults.filter(a => { if (seen.has(a.title)) return false; seen.add(a.title); return true; }).slice(0, 30);
    await Promise.allSettled(deduped.map(async (article) => {
      const meta = await fetchOgMeta(article.link);
      if (meta.image) article.image = meta.image;
      if (meta.date && !article.date) article.date = meta.date;
    }));
    console.log('Complex scraped: ' + deduped.length + ' items');
    return deduped;
  } catch(e) { console.error('Complex scrape error:', e.message); return []; }
  finally { await page.close(); }
}

async function fetchSoleRetriever(browser) {
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({ 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });
    await page.goto('https://www.soleretriever.com/news', { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Wait for both the main grid AND sidebar to render (34 total on the page)
    try {
      await page.waitForFunction(() =>
        document.querySelectorAll('a[href*="/news/articles/"]').length >= 25,
        { timeout: 20000 }
      );
    } catch(e) { console.log('SR: proceeding with available articles'); }

    await page.waitForTimeout(1000);

    const results = await page.evaluate(() => {
      // Convert "about X hours/minutes/days ago" → approximate timestamp for sorting
      const relativeToTimestamp = (str) => {
        if (!str) return 0;
        const now = Date.now();
        const m = str.match(/about\s+(\d+)\s+(second|minute|hour|day|week)/i);
        if (!m) return 0;
        const n = parseInt(m[1]);
        const unit = m[2].toLowerCase();
        const ms = { second: 1000, minute: 60000, hour: 3600000, day: 86400000, week: 604800000 };
        return now - n * (ms[unit] || 0);
      };

      const extractFromAnchor = (a) => {
        const href = a.href || '';
        const headingEl = a.querySelector('h1,h2,h3,h4,h5,h6');
        const titleClsEl = a.querySelector('[class*="title"],[class*="headline"],[class*="heading"]');
        const pEl = a.querySelector('p');
        let title = headingEl?.innerText?.trim() || titleClsEl?.innerText?.trim() || pEl?.innerText?.trim() || '';

        if (!title || title.length < 5) {
          title = a.innerText.trim().split('\n')
            .map(l => l.trim())
            .filter(l => l.length > 0
              && !/^about\s+\d+\s+(second|minute|hour|day|week)/i.test(l)
              && !/^\d+\s*(s|m|h|d|w)\s*ago$/i.test(l)
              && !/^(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d/i.test(l)
            )[0] || '';
        }
        if (!title || title.length < 5) return null;

        // Capture the raw relative date string (e.g. "about 3 hours ago")
        const timeEl = a.querySelector('time');
        let dateStr = timeEl?.getAttribute('datetime') || timeEl?.innerText?.trim() || '';
        if (!dateStr) {
          const lines = a.innerText.trim().split('\n').map(l => l.trim());
          dateStr = lines.find(l => /about\s+\d+\s+(second|minute|hour|day|week)/i.test(l))
                 || lines.find(l => /^(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d/i.test(l))
                 || '';
        }

        const img = a.querySelector('img');
        // Compute a numeric sort key from the relative string
        const sortKey = relativeToTimestamp(dateStr) || new Date(dateStr).getTime() || 0;

        return {
          source: 'soleretriever', sourceName: 'Sole Retriever',
          title, description: '', link: href,
          date: dateStr,
          _sortKey: sortKey,
          image: img?.src?.startsWith('http') ? img.src : null
        };
      };

      const results = [];
      document.querySelectorAll('a[href*="/news/articles/"]').forEach(a => {
        const item = extractFromAnchor(a);
        if (item) results.push(item);
      });

      // Dedupe by URL
      const seen = new Set();
      const deduped = results.filter(a => { if (seen.has(a.link)) return false; seen.add(a.link); return true; });

      // Sort newest first using the numeric sort key, then take top 20
      deduped.sort((a, b) => b._sortKey - a._sortKey);
      return deduped.slice(0, 20).map(({ _sortKey, ...rest }) => rest);
    });

    console.log('SR found ' + results.length + ' articles');

    // Only fetch og:meta for articles that are missing both image AND date —
    // most will have images inline from the page, skipping saves ~5s
    await Promise.allSettled(results.map(async (article) => {
      if (article.image && article.date) return;
      const meta = await fetchOgMeta(article.link);
      if (meta.image && !article.image) article.image = meta.image;
      if (meta.date && !article.date) article.date = meta.date;
    }));

    console.log('Sole Retriever scraped: ' + results.length + ' items');
    return results;
  } catch(e) { console.error('Sole Retriever scrape error:', e.message); return []; }
  finally { await page.close(); }
}

async function fetchHNHH(browser) {
  const page = await browser.newPage();
  try {
    await page.goto('https://www.hotnewhiphop.com/articles/sneakers', { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(5000);
    const results = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('a[href]').forEach(a => {
        const href = a.href || '';
        if (!href.includes('hotnewhiphop.com')) return;
        const path = new URL(href).pathname;
        const segments = path.split('/').filter(Boolean);
        if (segments.length < 2) return;
        if (!segments[segments.length - 1].includes('.')) return;
        const textEls = a.querySelectorAll('h1,h2,h3,h4,[class*="title"],[class*="headline"],[class*="name"]');
        const title = textEls.length ? textEls[0].innerText.trim() : a.innerText.trim().split('\n')[0].trim();
        if (!title || title.length < 15) return;
        results.push({ source: 'hnhh', sourceName: 'HotNewHipHop', title, description: '', link: href, date: '', image: null });
      });
      const seen = new Set();
      return results.filter(a => { if (seen.has(a.title)) return false; seen.add(a.title); return true; }).slice(0, 20);
    });
    await Promise.allSettled(results.map(async (article) => {
      const meta = await fetchOgMeta(article.link);
      if (meta.image) article.image = meta.image;
      if (meta.date) article.date = meta.date;
    }));
    console.log('HotNewHipHop scraped: ' + results.length + ' items');
    return results;
  } catch(e) { console.error('HotNewHipHop scrape error:', e.message); return []; }
  finally { await page.close(); }
}

async function fetchAllFeeds() {
  console.log('Fetching all feeds...');
  let browser;
  try {
    // RSS sources — kick off immediately and run in parallel with Playwright work
    const rssPromise = Promise.allSettled([
      fetchHypebeast(), fetchHighsnobiety(), fetchSneakerNews(), fetchHipHopDX()
    ]);

    // Single Chromium instance shared across all three Playwright scrapers
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
    const complexArticles = await fetchComplex(browser).catch(e => { console.error('Complex failed:', e.message); return []; });
    const srArticles      = await fetchSoleRetriever(browser).catch(e => { console.error('SR failed:', e.message); return []; });
    const hnhhArticles    = await fetchHNHH(browser).catch(e => { console.error('HNHH failed:', e.message); return []; });

    // Close browser before awaiting RSS — frees memory while we wait
    if (browser) { await browser.close(); browser = null; }

    const [hypebeast, highsnobiety, sneakernews, hiphopdx] = await rssPromise;
    const articles = [
      ...(hypebeast.status    === 'fulfilled' ? hypebeast.value    : []),
      ...(highsnobiety.status === 'fulfilled' ? highsnobiety.value : []),
      ...(sneakernews.status  === 'fulfilled' ? sneakernews.value  : []),
      ...(hiphopdx.status     === 'fulfilled' ? hiphopdx.value     : []),
      ...complexArticles,
      ...srArticles,
      ...hnhhArticles
    ];
    articles.sort((a, b) => new Date(b.date) - new Date(a.date));
    cachedArticles = articles;
    lastFetch = Date.now();
    console.log(`Fetched ${articles.length} articles total`);
    return articles;
  } catch (e) { console.error('fetchAllFeeds:', e); return cachedArticles; }
  finally { if (browser) await browser.close(); }
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

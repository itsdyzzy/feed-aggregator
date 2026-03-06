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

async function fetchComplex() {
  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
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
            const allText = a.innerText.trim();
            const lines = allText.split('\n').map(l => l.trim()).filter(l => l.length > 15);
            const title = lines[0] || '';
            if (!title || title.length < 10) return;
            const card = a.closest('article,[class*="card"],[class*="item"],[class*="post"]');
            const timeEl = card ? card.querySelector('time') : null;
            results.push({
              source: 'complex', sourceName: 'Complex',
              title, description: '', link: href,
              date: timeEl ? (timeEl.getAttribute('datetime') || '') : '',
              image: null
            });
          });
          const seen = new Set();
          return results.filter(a => { if (seen.has(a.title)) return false; seen.add(a.title); return true; });
        });
        allResults.push(...results);
      } catch(e) { console.error('Complex section error:', e.message); }
    }

    // Dedupe across sections
    const seen = new Set();
    const deduped = allResults.filter(a => { if (seen.has(a.title)) return false; seen.add(a.title); return true; }).slice(0, 30);

    // Fetch og:image and date for all
    await Promise.allSettled(deduped.map(async (article) => {
      const meta = await fetchOgMeta(article.link);
      if (meta.image) article.image = meta.image;
      if (meta.date && !article.date) article.date = meta.date;
    }));

    console.log('Complex scraped: ' + deduped.length + ' items');
    return deduped;
  } catch(e) {
    console.error('Complex scrape error:', e.message);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

async function fetchSoleRetriever() {
  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });
    await page.goto('https://www.soleretriever.com/news', { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Wait until at least one article link appears
    try {
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll('a[href]'))
          .some(a => a.href.includes('/news/articles/')),
        { timeout: 20000 }
      );
    } catch(e) { console.log('SR: timed out waiting for articles'); }

    // Scroll the "Just In" sidebar to trigger lazy-loading of all items
    await page.evaluate(async () => {
      let justInEl = null;
      for (const el of document.querySelectorAll('*')) {
        if (el.children.length === 0 && el.innerText?.trim() === 'Just In') {
          justInEl = el;
          break;
        }
      }
      if (!justInEl) return;

      // Walk up to find the scrollable sidebar container
      let container = justInEl.parentElement;
      for (let i = 0; i < 6; i++) {
        if (!container) break;
        if (container.scrollHeight > container.clientHeight + 50) break;
        container = container.parentElement;
      }
      if (!container) return;

      // Scroll in steps to trigger lazy loading
      const step = container.clientHeight || 400;
      for (let pos = 0; pos < container.scrollHeight; pos += step) {
        container.scrollTop = pos;
        await new Promise(r => setTimeout(r, 400));
      }
      container.scrollTop = container.scrollHeight;
      await new Promise(r => setTimeout(r, 800));
    });

    const results = await page.evaluate(() => {
      const results = [];

      // Find the "Just In" heading — target leaf nodes only to avoid matching
      // parent containers whose innerText also contains "Just In" + all child text
      let justInContainer = null;
      for (const el of document.querySelectorAll('*')) {
        if (el.children.length === 0 && el.innerText?.trim() === 'Just In') {
          // Walk up to find nearest ancestor that actually contains article links
          let ancestor = el.parentElement;
          for (let i = 0; i < 8; i++) {
            if (!ancestor) break;
            if (ancestor.querySelector('a[href*="/news/articles/"]')) {
              justInContainer = ancestor;
              break;
            }
            ancestor = ancestor.parentElement;
          }
          break;
        }
      }

      const extractFromAnchor = (a) => {
        const href = a.href || '';

        // innerText is structured like: "about 4 hours ago\nNike Continues the Air Force 1..."
        // Strip out timestamp lines, keep the actual title lines
        const lines = a.innerText.trim().split('\n')
          .map(l => l.trim())
          .filter(l =>
            l.length > 0 &&
            !/^about\s+\d+\s+(second|minute|hour|day|week)/i.test(l) &&
            !/^\d+\s*(s|m|h|d|w)\s*ago$/i.test(l)
          );

        const title = lines[0] || '';
        if (!title || title.length < 10) return null;

        // Prefer a <time> element's datetime attr; fall back to "about X ago" text
        const timeEl = a.querySelector('time');
        let date = timeEl?.getAttribute('datetime') || timeEl?.innerText?.trim() || '';
        if (!date) {
          const raw = a.innerText.trim().split('\n').map(l => l.trim());
          date = raw.find(l => /about\s+\d+\s+(second|minute|hour|day|week)/i.test(l)) || '';
        }

        // Grab thumbnail if the anchor contains one
        const img = a.querySelector('img');
        const image = img?.src?.startsWith('http') ? img.src : null;

        return { source: 'soleretriever', sourceName: 'Sole Retriever', title, description: '', link: href, date, image };
      };

      if (justInContainer) {
        justInContainer.querySelectorAll('a[href*="/news/articles/"]').forEach(a => {
          const item = extractFromAnchor(a);
          if (item) results.push(item);
        });
      }

      // Fallback: scan whole page for article links
      if (results.length === 0) {
        document.querySelectorAll('a[href*="/news/articles/"]').forEach(a => {
          const item = extractFromAnchor(a);
          if (item) results.push(item);
        });
      }

      // Dedupe by URL (not title — avoids dropping articles with similar names)
      const seen = new Set();
      return results.filter(a => {
        if (seen.has(a.link)) return false;
        seen.add(a.link);
        return true;
      }).slice(0, 20);
    });

    console.log('SR found ' + results.length + ' articles');

    // Only hit og meta for items still missing image or date
    await Promise.allSettled(results.map(async (article) => {
      if (article.image && article.date) return;
      const meta = await fetchOgMeta(article.link);
      if (meta.image && !article.image) article.image = meta.image;
      if (meta.date && !article.date) article.date = meta.date;
    }));

    console.log('Sole Retriever scraped: ' + results.length + ' items');
    return results;
  } catch(e) {
    console.error('Sole Retriever scrape error:', e.message);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

async function fetchHNHH() {
  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.goto('https://www.hotnewhiphop.com/articles/sneakers', { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(5000);

    const sampleHrefs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]'))
        .map(a => a.href).filter(h => h.includes('hotnewhiphop.com') && h.split('/').length > 4).slice(0, 15)
    );
    console.log('HNHH deep hrefs:', JSON.stringify(sampleHrefs));

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
  } catch(e) {
    console.error('HotNewHipHop scrape error:', e.message);
    return [];
  } finally {
    if (browser) await browser.close();
  }
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

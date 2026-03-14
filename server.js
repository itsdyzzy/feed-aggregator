const express = require('express');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());
const Parser = require('rss-parser');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();

// ─── Seen-URLs: persistent deduplication across fetch cycles ─────────────────
const SEEN_URLS_FILE = path.join(__dirname, 'seen-urls.json');
let seenUrls = new Set();

function loadSeenUrls() {
  try {
    if (fs.existsSync(SEEN_URLS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SEEN_URLS_FILE, 'utf8'));
      seenUrls = new Set(data);
      console.log(`Loaded ${seenUrls.size} seen URLs from disk`);
    }
  } catch(e) { console.error('Failed to load seen-urls.json:', e.message); }
}

function saveSeenUrls() {
  try {
    fs.writeFileSync(SEEN_URLS_FILE, JSON.stringify([...seenUrls]), 'utf8');
  } catch(e) { console.error('Failed to save seen-urls.json:', e.message); }
}

function markUrlsSeen(articles) {
  let added = 0;
  for (const a of articles) {
    if (a.link && !seenUrls.has(a.link)) { seenUrls.add(a.link); added++; }
  }
  if (added > 0) saveSeenUrls();
  return added;
}

function pruneSeenUrls() {
  if (seenUrls.size > 2000) {
    const arr = [...seenUrls];
    seenUrls = new Set(arr.slice(arr.length - 2000));
    saveSeenUrls();
    console.log('Pruned seen-urls to 2000 entries');
  }
}

loadSeenUrls();
const PORT = process.env.PORT || 3000;

const parser = new Parser({
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

// Lenient parser for feeds with malformed XML (e.g. unescaped HTML in description fields)
const lenientParser = new Parser({
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSS reader)' },
  xml2js: { strict: false, trim: true },
  customFields: { item: [['media:content', 'mediaContent'], ['media:thumbnail', 'mediaThumbnail']] }
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
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' } });
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

// Playwright-based og:meta fetcher for sites that block plain HTTP (e.g. Hypebeast CDN)
async function fetchOgMetaViaBrowser(browser, url) {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const meta = await page.evaluate(() => {
      const imgEl = document.querySelector('meta[property="og:image"]');
      const dateEl = document.querySelector('meta[property="article:published_time"]');
      const image = imgEl?.content?.startsWith('http') ? imgEl.content : null;
      const date = dateEl?.content || null;
      return { image, date };
    });
    return meta;
  } catch { return { image: null, date: null }; }
  finally { await page.close(); }
}

async function fetchViaRss2json(feedUrl, source, sourceName) {
  try {
    const apiUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feedUrl)}`;
    const res = await fetch(apiUrl, { signal: AbortSignal.timeout(15000) });
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
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSS reader)', 'Accept': 'application/rss+xml, text/xml, */*' }
    });
    if (!res.ok) { console.error(`${sourceName} direct: HTTP ${res.status}`); return null; }
    const raw = await res.text();
    const preExtracted = preExtractFromRaw(raw);

    // Try 1: sanitize + strict parse
    try {
      const xml = sanitizeRssFeed(raw);
      const feed = await parser.parseString(xml);
      if (feed.items?.length) {
        console.log(`${sourceName} direct: ${feed.items.length} items`);
        return feed.items.slice(0, 20).map((item, i) => ({ source, sourceName, title: item.title || '', description: item.contentSnippet || preExtracted[i]?.description || '', link: item.link || '', date: item.pubDate || item.isoDate || '', image: extractImage(item) || preExtracted[i]?.image || null }));
      }
    } catch(e) { console.error(`${sourceName} strict parse failed (${e.message}), trying lenient`); }

    // Try 2: lenient parser
    try {
      const feed = await lenientParser.parseString(raw);
      if (feed.items?.length) {
        console.log(`${sourceName} lenient: ${feed.items.length} items`);
        return feed.items.slice(0, 20).map((item, i) => ({ source, sourceName, title: item.title || '', description: item.contentSnippet || preExtracted[i]?.description || '', link: item.link || '', date: item.pubDate || item.isoDate || '', image: extractImage(item) || preExtracted[i]?.image || null }));
      }
    } catch(e) { console.error(`${sourceName} lenient parse failed: ${e.message}`); }

  } catch (e) { console.error(`${sourceName} direct:`, e.message); }
  return null;
}

// Pre-extract image URLs and description text from raw XML before sanitizeRssFeed strips content:encoded.
function preExtractFromRaw(raw) {
  const results = [];
  const itemBlocks = raw.split(/<item[\s>]/i);
  for (let i = 1; i < itemBlocks.length; i++) {
    const block = itemBlocks[i];
    let image = null, description = '';

    // Check media:content and media:thumbnail first (highest quality)
    const mediaMatch = block.match(/media:content[^>]+url=["']([^"']+)["']/i)
                    || block.match(/media:thumbnail[^>]+url=["']([^"']+)["']/i)
                    || block.match(/enclosure[^>]+url=["']([^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["']/i);
    if (mediaMatch) image = mediaMatch[1];

    // Extract content:encoded — scoped correctly within this item block
    const ceOpen = block.indexOf('<content:encoded');
    const ceClose = block.indexOf('</content:encoded>');
    if (ceOpen !== -1 && ceClose !== -1 && ceClose > ceOpen) {
      let ce = block.slice(ceOpen, ceClose);
      // Strip CDATA wrapper(s)
      ce = ce.replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '');
      // Extract image from content:encoded if not already found
      if (!image) {
        const imgMatch = ce.match(/<img[^>]+src=["']([^"']+)["']/i)
                      || ce.match(/<img[^>]+src=([^\s>]+)/i)
                      || ce.match(/https?:\/\/[^\s"'<>]+\.(?:jpg|jpeg|png|webp)(?:[?][^\s"'<>]*)?/i);
        if (imgMatch) image = (imgMatch[1] || imgMatch[0]).replace(/['"]/g, '');
      }
      // Plain text description from content:encoded
      description = ce.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    }

    // If still no image, try any bare img src in the whole item block
    if (!image) {
      const bareImg = block.match(/<img[^>]+src=["']([^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["']/i);
      if (bareImg) image = bareImg[1];
    }

    // Skip tracking pixels and tiny images
    if (image && (image.includes('pixel') || image.includes('1x1') || image.includes('tracking'))) {
      image = null;
    }

    results.push({ image, description });
  }
  return results;
}

function sanitizeRssFeed(xml) {
  // Strip ONLY tags known to contain raw HTML blobs — NOT 'content' alone (breaks media:content)
  const htmlTags = [
    'content:encoded', 'excerpt:encoded',
    'media:description', 'slash:comments', 'wfw:commentRss',
    'dc:description', 'atom:content'
  ];
  for (const tag of htmlTags) {
    const open = `<${tag}`, close = `</${tag}>`;
    const parts = xml.split(close);
    for (let i = 0; i < parts.length - 1; i++) {
      const start = parts[i].lastIndexOf(open);
      if (start !== -1) parts[i] = parts[i].slice(0, start) + `<${tag}>`;
    }
    xml = parts.join(close);
  }
  // Strip <description> blocks containing raw HTML (no CDATA)
  xml = xml.replace(/<description>([\s\S]*?)<\/description>/g, (match, inner) => {
    if (inner.includes('<p') || inner.includes('<div') || inner.includes('<img') || inner.includes('<a ') || inner.includes('<span')) {
      return '<description></description>';
    }
    return match;
  });
  // Fix bare & not part of a valid XML entity
  xml = xml.replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');
  return xml;
}

async function fetchHypebeast(browser) {
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    });
    await page.goto('https://hypebeast.com/latest', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Scroll down to trigger lazy-load for more articles and images
    await page.setViewportSize({ width: 1280, height: 900 });
    for (let i = 1; i <= 8; i++) {
      await page.evaluate((pct) => window.scrollTo(0, document.body.scrollHeight * pct), i * 0.125);
      await page.waitForTimeout(300);
    }
    await page.waitForTimeout(1000);

    const results = await page.evaluate(() => {
      const articles = [];
      document.querySelectorAll('a[href]').forEach(a => {
        const href = a.href || '';
        if (!href.includes('hypebeast.com')) return;
        if (!/hypebeast\.com\/\d{4}\//.test(href)) return;
        const card = a.closest('article, [class*="post"], [class*="card"], [class*="item"], li');
        if (!card) return;
        const titleEl = card.querySelector('h1,h2,h3,h4,[class*="title"]') || a;
        const title = (titleEl?.innerText || '').trim().split('\n')[0].trim();
        if (!title || title.length < 10) return;
        const timeEl = card.querySelector('time');
        const img = card.querySelector('img');
        // Try every possible image attribute
        const imgSrc = (img?.src?.startsWith('http') && !img.src.includes('data:')) ? img.src
          : img?.dataset?.src || img?.dataset?.lazySrc || img?.dataset?.original
          || img?.dataset?.srcset?.split(' ')[0]
          || img?.srcset?.split(' ')[0] || null;
        articles.push({
          source: 'hypebeast', sourceName: 'Hypebeast',
          title, description: '', link: href,
          date: timeEl?.getAttribute('datetime') || '',
          image: (imgSrc && !imgSrc.includes('data:')) ? imgSrc : null
        });
      });
      const seen = new Set();
      return articles.filter(a => {
        if (seen.has(a.link)) return false;
        seen.add(a.link);
        return true;
      }).slice(0, 40);
    });

    console.log(`Hypebeast /latest: ${results.length} items, ${results.filter(r=>r.image).length} with images`);

    // Fetch og:meta for ALL missing images and dates (not capped — images are critical for HB)
    await Promise.allSettled(results.filter(r => !r.image || !r.date).map(async (a) => {
      const meta = await fetchOgMeta(a.link);
      if (meta.image && !a.image) a.image = meta.image;
      if (meta.date && !a.date) a.date = meta.date;
    }));

    // Rewrite through image proxy to bypass CDN hotlink protection
    for (const a of results) {
      if (a.image) a.image = '/api/img?url=' + encodeURIComponent(a.image);
    }

    return results;
  } catch(e) { console.error('Hypebeast error:', e.message); return []; }
  finally { await page.close(); }
}

async function fetchHighsnobiety(browser) {
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    });
    await page.goto('https://www.highsnobiety.com/page/1/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    const results = await page.evaluate(() => {
      const articles = [];
      const feedSection = document.querySelector('[data-cy="section-SectionContentFeedV2"]');
      const teasers = (feedSection || document).querySelectorAll('[data-cy="teaser"]');
      teasers.forEach(teaser => {
        const linkEl = teaser.querySelector('[data-cy="teaser-link"]');
        const href = linkEl?.href || '';
        if (!href || !href.includes('highsnobiety.com')) return;
        const titleEl = teaser.querySelector('h1,h2,h3,h4,[class*="title"],[class*="heading"]');
        const title = (titleEl?.innerText || '').trim().split('\n')[0].trim();
        if (!title || title.length < 5) return;
        const imgEl = teaser.querySelector('[data-cy="teaser-image"] img, img');
        const image = imgEl?.src?.startsWith('http') ? imgEl.src
          : (imgEl?.dataset?.src || imgEl?.srcset?.split(' ')[0] || null);
        const timeEl = teaser.querySelector('time');
        const date = timeEl?.getAttribute('datetime') || timeEl?.innerText?.trim() || '';
        articles.push({ source: 'highsnobiety', sourceName: 'Highsnobiety', title, description: '', link: href, date, image: image || null });
      });
      const seen = new Set();
      return articles.filter(a => { if (seen.has(a.link)) return false; seen.add(a.link); return true; }).slice(0, 20);
    });

    console.log(`Highsnobiety scraped: ${results.length} items`);

    // Enrich og:meta for any missing date or image
    const needsMeta = results.filter(a => !a.date || !a.image).slice(0, 15);
    await Promise.allSettled(needsMeta.map(async (a) => {
      const meta = await fetchOgMeta(a.link);
      if (meta.image && !a.image) a.image = meta.image;
      if (meta.date && !a.date) a.date = meta.date;
    }));

    if (results.length > 0) return results;
  } catch(e) { console.error('Highsnobiety scrape error:', e.message); }
  finally { await page.close(); }

  // RSS fallback
  console.log('Highsnobiety: falling back to RSS');
  try {
    const res = await fetch('https://www.highsnobiety.com/feed/', {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSS reader)', 'Accept': 'application/rss+xml, text/xml, */*', 'Cache-Control': 'no-cache' }
    });
    if (res.ok) {
      const raw = await res.text();
      const feed = await parser.parseString(sanitizeRssFeed(raw));
      if (feed.items?.length) {
        return feed.items.slice(0, 20).map(item => ({
          source: 'highsnobiety', sourceName: 'Highsnobiety',
          title: item.title || '', description: item.contentSnippet || '',
          link: item.link || '', date: item.pubDate || item.isoDate || '',
          image: extractImage(item)
        }));
      }
    }
  } catch(e) { console.error('Highsnobiety RSS fallback failed:', e.message); }
  return [];
}

async function fetchSneakerNews() {
  try {
    const res = await fetch('https://sneakernews.com/feed/', {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSS reader)', 'Accept': 'application/rss+xml, text/xml, */*' }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const raw = await res.text();
    const preExtracted = preExtractFromRaw(raw);
    const xml = sanitizeRssFeed(raw);
    const feed = await parser.parseString(xml);
    const items = feed.items?.slice(0, 20) || [];
    const isPlaceholder = (url) => !url || /ksfin|placeholder|default-img|blank/i.test(url) || url.startsWith('data:');
    const articles = items.map((item, i) => {
      const img = extractImage(item) || preExtracted[i]?.image || null;
      return {
        source: 'sneakernews', sourceName: 'Sneaker News',
        title: item.title || '',
        description: item.contentSnippet || preExtracted[i]?.description || '',
        link: item.link || '', date: item.pubDate || item.isoDate || '',
        image: isPlaceholder(img) ? null : img
      };
    });
    // Fetch og:image for articles with missing or placeholder images
    const needsImg = articles.filter(a => !a.image);
    await Promise.allSettled(needsImg.map(async (a) => {
      const meta = await fetchOgMeta(a.link);
      if (meta.image) a.image = meta.image;
    }));
    console.log('Sneaker News: ' + articles.length + ' items');
    return articles;
  } catch (e) {
    console.error('Sneaker News direct:', e.message);
    const r2j = await fetchViaRss2json('https://sneakernews.com/feed/', 'sneakernews', 'Sneaker News');
    return r2j || [];
  }
}


async function fetchJustFreshKicks() {
  try {
    const res = await fetch('https://justfreshkicks.com/feed/', {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSS reader)', 'Accept': 'application/rss+xml, text/xml, */*' }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const raw = await res.text();
    const preExtracted = preExtractFromRaw(raw);
    const xml = sanitizeRssFeed(raw);
    const feed = await parser.parseString(xml);
    const items = feed.items?.slice(0, 20) || [];
    const articles = items.map((item, i) => ({
      source: 'justfreshkicks', sourceName: 'Just Fresh Kicks',
      title: item.title || '',
      description: item.contentSnippet || preExtracted[i]?.description || '',
      link: item.link || '', date: item.pubDate || item.isoDate || '',
      image: extractImage(item) || preExtracted[i]?.image || null
    }));
    const needsImg = articles.filter(a => !a.image);
    await Promise.allSettled(needsImg.map(async (a) => {
      const meta = await fetchOgMeta(a.link);
      if (meta.image) a.image = meta.image;
    }));
    console.log('Just Fresh Kicks: ' + articles.length + ' items');
    return articles;
  } catch(e) {
    console.error('Just Fresh Kicks:', e.message);
    const r2j = await fetchViaRss2json('https://justfreshkicks.com/feed/', 'justfreshkicks', 'Just Fresh Kicks');
    return r2j || [];
  }
}

async function fetchHipHopDX() {
  try {
    const res = await fetch('https://hiphopdx.com/rss/news.xml', {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSS reader)', 'Accept': 'application/rss+xml, text/xml, */*' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let xml = await res.text();
    xml = xml.replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');
    const feed = await parser.parseString(xml);
    if (feed.items?.length) {
      console.log(`HipHopDX: ${feed.items.length} items`);
      const articles = feed.items.slice(0, 20).map(item => ({
        source: 'hiphopdx', sourceName: 'HipHopDX',
        title: item.title || '', description: item.contentSnippet || '',
        link: item.link || '', date: item.pubDate || item.isoDate || '',
        image: extractImage(item)
      }));
      const needsImg = articles.filter(a => !a.image);
      await Promise.allSettled(needsImg.map(async (a) => {
        const meta = await fetchOgMeta(a.link);
        if (meta.image) a.image = meta.image;
      }));
      return articles;
    }
  } catch (e) { console.error('HipHopDX:', e.message); }
  return [];
}


async function fetchComplex(browser) {
  // Open both pages simultaneously instead of sequentially — saves 2.5s
  const pages = await Promise.all([
    browser.newPage(),
    browser.newPage()
  ]);
  const sections = ['https://www.complex.com/sneakers', 'https://www.complex.com/style'];
  try {
    const sectionResults = await Promise.all(sections.map(async (section, i) => {
      const page = pages[i];
      try {
        await page.setExtraHTTPHeaders({ 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });
        await page.goto(section, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2500);
        return await page.evaluate(() => {
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
            const img = card ? card.querySelector('img') : null;
            results.push({ source: 'complex', sourceName: 'Complex', title, description: '', link: href, date: timeEl ? (timeEl.getAttribute('datetime') || '') : '', image: img?.src?.startsWith('http') ? img.src : null });
          });
          const seen = new Set();
          return results.filter(a => { if (seen.has(a.title)) return false; seen.add(a.title); return true; });
        });
      } catch(e) { console.error('Complex section error:', e.message); return []; }
      finally { await page.close(); }
    }));

    const allResults = sectionResults.flat();
    const seen = new Set();
    const deduped = allResults.filter(a => { if (seen.has(a.title)) return false; seen.add(a.title); return true; }).slice(0, 30);
    // Fetch og:meta for all articles missing a date (minimize requests, cap at 10)
    const needsMeta = deduped.filter(a => !a.date).slice(0, 10);
    await Promise.allSettled(needsMeta.map(async (a) => {
      const meta = await fetchOgMeta(a.link);
      if (meta.image && !a.image) a.image = meta.image;
      if (meta.date && !a.date) a.date = meta.date;
    }));
    console.log('Complex scraped: ' + deduped.length + ' items');
    return deduped;
  } catch(e) { console.error('Complex scrape error:', e.message); return []; }
}

async function fetchModernNotoriety(browser) {
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({ 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });
    await page.goto('https://modernnotoriety.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    const results = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('a[href]').forEach(a => {
        const href = a.href || '';
        if (!href.includes('modernnotoriety.com')) return;
        if (href.match(/\/(nike|air-jordan|adidas|new-balance|vans|reebok|contact|page|category|tag|#)\/?$/i)) return;
        const segs = new URL(href).pathname.split('/').filter(Boolean);
        if (segs.length < 1 || segs[0].length < 3) return;
        const titleEl = a.querySelector('h1,h2,h3,h4,[class*="title"],[class*="entry"],[class*="post-title"]');
        const title = titleEl ? titleEl.innerText.trim() : a.innerText.trim().split('\n')[0].trim();
        if (!title || title.length < 10) return;
        const card = a.closest('article,[class*="card"],[class*="post"],[class*="entry"]');
        const timeEl = card?.querySelector('time');
        const img = card?.querySelector('img');
        results.push({ source: 'modernnotoriety', sourceName: 'Modern Notoriety', title, description: '', link: href, date: timeEl?.getAttribute('datetime') || timeEl?.innerText?.trim() || '', image: img?.src?.startsWith('http') ? img.src : null });
      });
      const seen = new Set();
      return results.filter(a => { if (seen.has(a.link)) return false; seen.add(a.link); return true; }).slice(0, 20);
    });
    // Fetch meta for all articles missing a date — cap at 5
    const needsMeta = results.filter(a => !a.date).slice(0, 5);
    await Promise.allSettled(needsMeta.map(async (a) => {
      const meta = await fetchOgMeta(a.link);
      if (meta.image && !a.image) a.image = meta.image;
      if (meta.date && !a.date) a.date = meta.date;
    }));
    console.log('Modern Notoriety scraped: ' + results.length + ' items');
    return results;
  } catch(e) { console.error('Modern Notoriety scrape error:', e.message); return []; }
  finally { await page.close(); }
}

// ─── Playwright scrapers (shared browser) ────────────────────────────────────

async function fetchWWD() {
  // Just get titles/links/dates from RSS — images fetched separately after browser closes
  const feedUrls = [
    'https://wwd.com/footwear-news/feed/',
    'https://wwd.com/footwear-news/sneaker-news/feed/',
  ];
  for (const feedUrl of feedUrls) {
    try {
      const res = await fetch(feedUrl, {
        signal: AbortSignal.timeout(12000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSS reader)', 'Accept': 'application/rss+xml, text/xml, */*' }
      });
      if (!res.ok) continue;
      const raw = await res.text();
      const xml = sanitizeRssFeed(raw);
      const feed = await parser.parseString(xml);
      if (feed.items?.length) {
        console.log(`WWD direct: ${feed.items.length} items`);
        return feed.items.slice(0, 10).map(item => ({
          source: 'wwd', sourceName: 'WWD',
          title: item.title || '', description: item.contentSnippet || '',
          link: item.link || '', date: item.pubDate || item.isoDate || '',
          image: null
        }));
      }
    } catch(e) { console.error(`WWD feed error: ${e.message}`); }
  }
  const r2j = await fetchViaRss2json('https://wwd.com/footwear-news/feed/', 'wwd', 'WWD');
  if (r2j?.length) return r2j;
  console.error('WWD: all feed attempts failed');
  return [];
}

async function fetchSoleRetriever() {
  // RSS-first — fast, structured, real ISO dates, no scraping needed
  const feedUrls = [
    'https://www.soleretriever.com/rss.xml',
    'https://www.soleretriever.com/rss',
    'https://www.soleretriever.com/feed',
    'https://www.soleretriever.com/news/feed',
  ];
  for (const feedUrl of feedUrls) {
    try {
      const res = await fetch(feedUrl, {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSS reader)', 'Accept': 'application/rss+xml, text/xml, */*' }
      });
      if (!res.ok) continue;
      let xml = await res.text();
      if (!xml.includes('<rss') && !xml.includes('<feed') && !xml.includes('<item')) continue;
      xml = xml.replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');
      const feed = await parser.parseString(xml);
      if (feed.items?.length) {
        console.log('Sole Retriever RSS (' + feedUrl + '): ' + feed.items.length + ' items');
        return feed.items.slice(0, 20).map(item => ({
          source: 'soleretriever', sourceName: 'Sole Retriever',
          title: item.title || '', description: item.contentSnippet || '',
          link: item.link || '', date: item.pubDate || item.isoDate || '',
          image: extractImage(item)
        }));
      }
    } catch(e) { /* try next */ }
  }
  // rss2json fallback
  const r2j = await fetchViaRss2json('https://www.soleretriever.com/rss.xml', 'soleretriever', 'Sole Retriever');
  if (r2j?.length) return r2j;
  console.error('Sole Retriever: all RSS attempts failed');
  return [];
}





// ─── Main orchestrator ────────────────────────────────────────────────────────

let fetchInProgress = null; // prevents duplicate concurrent fetches

async function fetchAllFeeds() {
  if (fetchInProgress) {
    console.log('Fetch already in progress, reusing...');
    return fetchInProgress;
  }
  fetchInProgress = (async () => {
    console.log('Fetching all feeds...');
    let browser;
    try {
      // RSS/fetch sources — fire immediately, run in parallel with Playwright work
      const rssPromise = Promise.allSettled([
        fetchSneakerNews(), fetchJustFreshKicks(), fetchHipHopDX(), fetchSoleRetriever(), fetchWWD()
      ]);

      // Single Chromium for all Playwright scrapers — pages run sequentially
      browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
      const hypeArticles       = await fetchHypebeast(browser).catch(e => { console.error('Hypebeast failed:', e.message); return []; });
      const highsnobArticles   = await fetchHighsnobiety(browser).catch(e => { console.error('Highsnobiety failed:', e.message); return []; });
      const complexArticles    = await fetchComplex(browser).catch(e => { console.error('Complex failed:', e.message); return []; });
      const mnArticles         = await fetchModernNotoriety(browser).catch(e => { console.error('MN failed:', e.message); return []; });

      // Close browser before awaiting RSS to free memory while we wait
      await browser.close(); browser = null;

      // Await RSS results + enrich WWD images in parallel (WWD has no images in RSS feed)
      const [rssResults] = await Promise.all([
        rssPromise,
        Promise.resolve()
      ]);
      const [sneakernews, justfreshkicks, hiphopdx, soleretriever, wwd] = rssResults;

      const wwdArticles = wwd.status === 'fulfilled' ? wwd.value : [];
      const wwdImagePromise = Promise.allSettled(wwdArticles.map(async (a) => {
        const meta = await fetchOgMeta(a.link);
        if (meta.image) a.image = meta.image;
      }));
      const articles = [
        ...hypeArticles,
        ...highsnobArticles,
        ...(sneakernews.status      === 'fulfilled' ? sneakernews.value      : []),
        ...(justfreshkicks.status === 'fulfilled' ? justfreshkicks.value : []),
        ...(hiphopdx.status      === 'fulfilled' ? hiphopdx.value      : []),
        ...(soleretriever.status === 'fulfilled' ? soleretriever.value : []),
        ...wwdArticles,
        ...complexArticles,
        ...mnArticles
      ];

      // Wait for WWD images (they fetch in parallel while we built the article list)
      await wwdImagePromise;
      articles.sort((a, b) => {
        const da = a.date ? new Date(a.date).getTime() : 0;
        const db = b.date ? new Date(b.date).getTime() : 0;
        const va = isNaN(da) ? 0 : da;
        const vb = isNaN(db) ? 0 : db;
        return vb - va;
      });

      // Deduplicate: merge newly scraped articles with existing cache
      // New articles = not yet seen ever; existing cache articles are kept as-is
      const cachedLinks = new Set(cachedArticles.map(a => a.link));
      const newArticles = articles.filter(a => !seenUrls.has(a.link) || cachedLinks.has(a.link));

      // Merge new + cached, dedupe by link
      const merged = [...newArticles];
      for (const a of cachedArticles) {
        if (!merged.some(m => m.link === a.link)) merged.push(a);
      }
      merged.sort((a, b) => {
        const da = a.date ? new Date(a.date).getTime() : 0;
        const db = b.date ? new Date(b.date).getTime() : 0;
        return (isNaN(db) ? 0 : db) - (isNaN(da) ? 0 : da);
      });

      const added = markUrlsSeen(articles);
      pruneSeenUrls();
      console.log(`Fetch complete: ${added} new URLs this cycle, ${merged.length} total in cache`);

      cachedArticles = merged.slice(0, 300);
      lastFetch = Date.now();
      return cachedArticles;
    } catch(e) { console.error('fetchAllFeeds:', e); return cachedArticles; }
    finally { if (browser) await browser.close(); fetchInProgress = null; }
  })();
  return fetchInProgress;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/articles', (req, res) => {
  // Always respond instantly with whatever is cached
  res.json({ articles: cachedArticles, lastFetch });
  // If cache is stale, kick off background refresh (don't await — user already has response)
  if (Date.now() - lastFetch > CACHE_TTL) {
    fetchAllFeeds().catch(console.error);
  }
});

app.get('/api/refresh', async (req, res) => {
  lastFetch = 0;
  await fetchAllFeeds();
  res.json({ articles: cachedArticles, lastFetch });
});

// ─── Image proxy — bypasses CDN hotlink/referer blocks ───────────────────────
app.get('/api/img', async (req, res) => {
  const url = req.query.url;
  if (!url || !url.startsWith('http')) return res.status(400).end();
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'image/webp,image/apng,image/*,*/*',
        'Referer': new URL(url).origin + '/'
      }
    });
    if (!response.ok) return res.status(response.status).end();
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // cache 24h in browser
    const buffer = await response.arrayBuffer();
    res.end(Buffer.from(buffer));
  } catch(e) { res.status(500).end(); }
});

app.get('*', (req, res) => {
  try {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    let html = fs.readFileSync(indexPath, 'utf8');

    // Inject pre-rendered articles for SEO — append a <script> before </body>
    // that pre-populates the grid before the main JS runs
    if (cachedArticles.length > 0) {
      const articles = cachedArticles.slice(0, 15);

      // Build static HTML cards for Google to index
      const staticCards = articles.map(a => {
        const safeTitle = (a.title || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        const safeDesc = (a.description || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        const safeLink = (a.link || '').replace(/"/g,'&quot;');
        const safeImg = (a.image || '').replace(/"/g,'&quot;');
        const safeSource = (a.sourceName || '').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        const sourceClass = (a.source || '').toLowerCase();
        const imgHtml = safeImg
          ? `<img class="card-img" src="${safeImg}" alt="${safeTitle}" loading="lazy">`
          : `<div class="card-img-placeholder">${safeSource}</div>`;
        return `<div class="card"><div class="card-meta"><span class="source-tag ${sourceClass}">${safeSource}</span></div>${imgHtml}<div class="card-title">${safeTitle}</div>${safeDesc ? `<div class="card-desc">${safeDesc}</div>` : ''}<a class="card-link" href="${safeLink}" target="_blank" rel="noopener">Read Full Article →</a></div>`;
      }).join('');

      // Replace spinner with static cards — Google sees these, JS will replace with live feed
      html = html.replace(
        /(<div class="grid" id="grid">)[\s\S]*?(<\/div>\s*
\s*
\s*<script>)/,
        `$1${staticCards}</div>

<script>`
      );
    }

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch(e) {
    console.error('SSR error:', e.message);
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

app.listen(PORT, () => {
  console.log('Feed aggregator running on port ' + PORT);
  // Initial fetch on boot
  fetchAllFeeds().catch(console.error);
  // Background refresh every 10 minutes — keeps cache warm regardless of traffic
  setInterval(() => fetchAllFeeds().catch(console.error), 10 * 60 * 1000);
});






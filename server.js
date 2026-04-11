const express = require('express');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());
const Parser = require('rss-parser');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
console.log('ANTHROPIC_API_KEY loaded:', process.env.ANTHROPIC_API_KEY ? 'YES (length=' + process.env.ANTHROPIC_API_KEY.length + ')' : 'NO - MISSING');

// ─── Featured Articles ────────────────────────────────────────────────────────
const FEATURED_FILE = path.join(__dirname, 'featured.json');
let featuredArticles = [];
function loadFeatured() {
  try { if (fs.existsSync(FEATURED_FILE)) featuredArticles = JSON.parse(fs.readFileSync(FEATURED_FILE, 'utf8')); } catch(e) {}
}
function saveFeatured() {
  try { fs.writeFileSync(FEATURED_FILE, JSON.stringify(featuredArticles), 'utf8'); } catch(e) {}
}
loadFeatured();

// ─── Ticker Text ──────────────────────────────────────────────────────────────
const TICKER_FILE = path.join(__dirname, 'ticker.json');
let tickerText = 'POWERED BY STAYGROUNDEAD: THE LATEST IN FASHION, STREETWEAR, CULTURE';
function loadTicker() {
  try { if (fs.existsSync(TICKER_FILE)) tickerText = JSON.parse(fs.readFileSync(TICKER_FILE, 'utf8')).text || tickerText; } catch(e) {}
}
function saveTicker() {
  try { fs.writeFileSync(TICKER_FILE, JSON.stringify({ text: tickerText }), 'utf8'); } catch(e) {}
}
loadTicker();

// ─── Email Subscribers ────────────────────────────────────────────────────────
const EMAILS_FILE = path.join(__dirname, 'emails.json');
let emailSubscribers = [];
function loadEmails() {
  try { if (fs.existsSync(EMAILS_FILE)) emailSubscribers = JSON.parse(fs.readFileSync(EMAILS_FILE, 'utf8')); } catch(e) {}
}
function saveEmails() {
  try { fs.writeFileSync(EMAILS_FILE, JSON.stringify(emailSubscribers), 'utf8'); } catch(e) {}
}
loadEmails();

// ─── Article Votes ────────────────────────────────────────────────────────────
const VOTES_FILE = path.join(__dirname, 'votes.json');
let votesData = {}; // { [urlKey]: { up: N, down: N } }
function loadVotes() {
  try { if (fs.existsSync(VOTES_FILE)) votesData = JSON.parse(fs.readFileSync(VOTES_FILE, 'utf8')); } catch(e) {}
}
function saveVotes() {
  try { fs.writeFileSync(VOTES_FILE, JSON.stringify(votesData), 'utf8'); } catch(e) {}
}
loadVotes();

// ─── Article Archive ──────────────────────────────────────────────────────────
const ARCHIVE_FILE = path.join(__dirname, 'articles-archive.json');
let articleArchive = [];
function loadArchive() {
  try { if (fs.existsSync(ARCHIVE_FILE)) articleArchive = JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8')); } catch(e) {}
}
function saveArchive() {
  try { fs.writeFileSync(ARCHIVE_FILE, JSON.stringify(articleArchive), 'utf8'); } catch(e) {}
}
function archiveOverflow(articles) {
  if (articles.length <= 280) return articles;
  const keep = articles.slice(0, 280);
  const overflow = articles.slice(280);
  const archiveLinks = new Set(articleArchive.map(a => a.link));
  let added = 0;
  for (const a of overflow) {
    if (!archiveLinks.has(a.link)) { articleArchive.push(a); archiveLinks.add(a.link); added++; }
  }
  if (added > 0) saveArchive();
  return keep;
}
loadArchive();

// ─── Video Archive ────────────────────────────────────────────────────────────
const VIDEO_ARCHIVE_FILE = path.join(__dirname, 'videos-archive.json');
let videoArchive = [];
function loadVideoArchive() {
  try { if (fs.existsSync(VIDEO_ARCHIVE_FILE)) videoArchive = JSON.parse(fs.readFileSync(VIDEO_ARCHIVE_FILE, 'utf8')); } catch(e) {}
}
function saveVideoArchive() {
  try { fs.writeFileSync(VIDEO_ARCHIVE_FILE, JSON.stringify(videoArchive), 'utf8'); } catch(e) {}
}
function archiveVideoOverflow(videos) {
  if (videos.length <= 280) return videos;
  const keep = videos.slice(0, 280);
  const overflow = videos.slice(280);
  const archiveIds = new Set(videoArchive.map(v => v.videoId));
  let added = 0;
  for (const v of overflow) {
    if (!archiveIds.has(v.videoId)) { videoArchive.push(v); archiveIds.add(v.videoId); added++; }
  }
  if (added > 0) saveVideoArchive();
  return keep;
}
loadVideoArchive();


const MANUAL_ARTICLES_FILE = path.join(__dirname, 'manual-articles.json');
let manualArticles = [];
function loadManualArticles() {
  try { if (fs.existsSync(MANUAL_ARTICLES_FILE)) manualArticles = JSON.parse(fs.readFileSync(MANUAL_ARTICLES_FILE, 'utf8')); } catch(e) {}
}
function saveManualArticles() {
  try { fs.writeFileSync(MANUAL_ARTICLES_FILE, JSON.stringify(manualArticles), 'utf8'); } catch(e) {}
}
loadManualArticles();

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

// ─── AI Summary Generator ─────────────────────────────────────────────────────
const summaryCache = new Map();

// ─── Weekly digest helpers ────────────────────────────────────────────────────
function getWeekSlug(date) {
  const d = new Date(date);
  d.setHours(0,0,0,0);
  d.setDate(d.getDate() - d.getDay()); // start of week (Sunday)
  return d.toISOString().split('T')[0]; // e.g. "2026-03-15"
}

function getWeekLabel(slug) {
  const d = new Date(slug + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function getWeeklyArticles(slug) {
  const weekStart = new Date(slug + 'T00:00:00Z').getTime();
  const weekEnd = weekStart + 7 * 24 * 60 * 60 * 1000;
  // Get articles from this week
  let articles = cachedArticles.filter(a => {
    if (!a.date) return false;
    const t = new Date(a.date).getTime();
    return t >= weekStart && t < weekEnd;
  });
  // If no date-filtered articles (e.g. current week), use all cached
  if (articles.length === 0) articles = cachedArticles;
  // Take up to 8 per source for balance
  const bySrc = {};
  articles.forEach(a => {
    if (!bySrc[a.source]) bySrc[a.source] = [];
    if (bySrc[a.source].length < 8) bySrc[a.source].push(a);
  });
  // Flatten and sort by date
  return Object.values(bySrc).flat().sort((a,b) => {
    return (new Date(b.date||0).getTime()) - (new Date(a.date||0).getTime());
  });
}

 // link -> generated summary, persists in memory

async function generateSummary(article) {
  if (summaryCache.has(article.link)) return summaryCache.get(article.link);
  try {
    const prompt = `You are writing a 2-sentence preview blurb for a streetwear news aggregator. Based only on the article title below, write a natural 2-sentence description of what this article is likely about. Write in plain text only — no markdown, no bullet points, no "Summary:" prefix, no hashtags. Do not mention that you are summarizing or that you lack access to the full article. Just write the 2 sentences directly.

Article title: ${article.title}
Source: ${article.sourceName}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 120,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) { console.error('Summary API error:', res.status); return null; }
    const data = await res.json();
    const summary = data.content?.[0]?.text?.trim() || null;
    if (summary) summaryCache.set(article.link, summary);
    return summary;
  } catch(e) { console.error('Summary generation failed:', e.message); return null; }
}

async function enrichWithSummaries(articles) {
  // Only process articles with no description that we haven't summarized yet
  const junkDesc = d => !d || /\b(SKU|MSRP|UPC|colorway|Release Date|Available Now|Summary[:\s]|^Name[:\s])/i.test(d) || d.length < 20;
  const needsSummary = articles.filter(a =>
    (!a.description || junkDesc(a.description)) &&
    !summaryCache.has(a.link) &&
    a.title && a.title.length > 10
  );
  // Clear junk descriptions so AI result gets written in
  needsSummary.forEach(a => { if (junkDesc(a.description)) a.description = ''; });
  if (needsSummary.length === 0) return;
  console.log(`Generating AI summaries for ${needsSummary.length} articles...`);
  // Process in batches of 5 to avoid rate limits
  for (let i = 0; i < needsSummary.length; i += 5) {
    const batch = needsSummary.slice(i, i + 5);
    await Promise.allSettled(batch.map(async (a) => {
      const summary = await generateSummary(a);
      if (summary) a.description = summary;
    }));
    // Small delay between batches to be respectful of rate limits
    if (i + 5 < needsSummary.length) await new Promise(r => setTimeout(r, 500));
  }
  console.log(`AI summaries complete.`);
}


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
      return data.items.slice(0, 40).map(item => ({
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
        return feed.items?.slice(0, 40).map((item, i) => ({ source, sourceName, title: item.title || '', description: item.contentSnippet || preExtracted[i]?.description || '', link: item.link || '', date: item.pubDate || item.isoDate || '', image: extractImage(item) || preExtracted[i]?.image || null }));
      }
    } catch(e) { console.error(`${sourceName} strict parse failed (${e.message}), trying lenient`); }

    // Try 2: lenient parser
    try {
      const feed = await lenientParser.parseString(raw);
      if (feed.items?.length) {
        console.log(`${sourceName} lenient: ${feed.items.length} items`);
        return feed.items?.slice(0, 40).map((item, i) => ({ source, sourceName, title: item.title || '', description: item.contentSnippet || preExtracted[i]?.description || '', link: item.link || '', date: item.pubDate || item.isoDate || '', image: extractImage(item) || preExtracted[i]?.image || null }));
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
  // Try RSS feeds first — more reliable than Playwright scraping
  const feeds = [
    'https://hypebeast.com/footwear/feed',
    'https://hypebeast.com/fashion/feed',
    'https://hypebeast.com/style/feed',
  ];
  try {
    const feedResults = await Promise.allSettled(feeds.map(async (feedUrl) => {
      const res = await fetch(feedUrl, {
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSS reader)', 'Accept': 'application/rss+xml, text/xml, */*' }
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const raw = await res.text();
      const preExtracted = preExtractFromRaw(raw);
      const xml = sanitizeRssFeed(raw);
      const feed = await parser.parseString(xml);
      return (feed.items || []).slice(0, 20).map((item, i) => ({
        source: 'hypebeast', sourceName: 'Hypebeast',
        title: item.title || '',
        description: item.contentSnippet || preExtracted[i]?.description || '',
        link: item.link || '',
        date: item.pubDate || item.isoDate || '',
        image: extractImage(item) || preExtracted[i]?.image || null
      }));
    }));

    const allItems = feedResults
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value);

    const seen = new Set();
    const deduped = allItems
      .filter(a => { if (seen.has(a.link)) return false; seen.add(a.link); return true; })
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
      .slice(0, 40);

    // Fetch og:image for any still missing images — use plain HTTP first, then browser fallback
    const needsImg = deduped.filter(a => !a.image);
    await Promise.allSettled(needsImg.map(async (a) => {
      const meta = await fetchOgMeta(a.link);
      if (meta.image) a.image = meta.image;
    }));
    // For articles still missing images, use Playwright browser (bypasses Hypebeast bot detection)
    const stillMissing = deduped.filter(a => !a.image);
    if (stillMissing.length > 0) {
      console.log(`Hypebeast: ${stillMissing.length} articles still missing images, trying browser fetch...`);
      await Promise.allSettled(stillMissing.map(async (a) => {
        const meta = await fetchOgMetaViaBrowser(browser, a.link);
        if (meta.image) a.image = meta.image;
      }));
    }

    // Proxy images through our server to bypass CDN hotlink protection
    for (const a of deduped) {
      if (a.image) a.image = '/api/img?url=' + encodeURIComponent(a.image);
    }

    console.log(`Hypebeast RSS: ${deduped.length} items, ${deduped.filter(r=>r.image).length} with images`);
    if (deduped.length > 0) return deduped;
    console.log('Hypebeast RSS returned 0 items, falling back to Playwright...');
  } catch(e) {
    console.error('Hypebeast RSS error:', e.message);
  }

  // Fallback to Playwright if RSS fails
  for (let attempt = 1; attempt <= 2; attempt++) {
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    });
    await page.goto('https://hypebeast.com/latest', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);
    await page.setViewportSize({ width: 1280, height: 900 });
    for (let i = 1; i <= 10; i++) {
      await page.evaluate((pct) => {
        if (document.body) window.scrollTo(0, document.body.scrollHeight * pct);
      }, i * 0.1);
      await page.waitForTimeout(600);
    }
    // Scroll back to top and wait for all lazy images to load
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(3000);
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
        let imgSrc = null;
        if (img) {
          imgSrc = (img.src?.startsWith('http') && !img.src.includes('data:')) ? img.src
            : img.dataset?.src || img.dataset?.lazySrc || img.dataset?.original
            || img.getAttribute('data-src') || img.getAttribute('data-lazy-src')
            || img.getAttribute('data-original-src') || img.getAttribute('data-image')
            || img.dataset?.srcset?.split(' ')[0]
            || img.srcset?.split(' ')[0] || null;
        }
        // Fallback: check <picture> <source> elements
        if (!imgSrc) {
          const source = card.querySelector('picture source[srcset]');
          if (source) imgSrc = source.getAttribute('srcset').split(' ')[0];
        }
        // Fallback: check any element with background-image
        if (!imgSrc) {
          const bgEl = card.querySelector('[style*="background-image"]');
          if (bgEl) {
            const bgMatch = bgEl.style.backgroundImage?.match(/url\(["']?([^"')]+)["']?\)/);
            if (bgMatch) imgSrc = bgMatch[1];
          }
        }
        // Fallback: check data attributes on the card or link itself
        if (!imgSrc) {
          imgSrc = a.dataset?.image || a.dataset?.thumbnail || card.dataset?.image || null;
        }
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
    for (const a of results) {
      if (a.image) a.image = '/api/img?url=' + encodeURIComponent(a.image);
    }
    return results;
  } catch(e) {
    console.error(`Hypebeast error (attempt ${attempt}):`, e.message);
    if (attempt === 2) return [];
  } finally { await page.close(); }
  }
  return [];
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
      return articles.filter(a => { if (seen.has(a.link)) return false; seen.add(a.link); return true; }).slice(0, 40);
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
        return feed.items?.slice(0, 40).map(item => ({
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

async function fetchSneakerNewsPlaywright(browser) {
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    });
    await page.goto('https://sneakernews.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Debug: log page structure to find correct selectors
    const debugInfo = await page.evaluate(() => {
      const tags = ['article', '.post', '.post-item', '.entry', '.td-module-thumb'];
      const counts = {};
      tags.forEach(t => { counts[t] = document.querySelectorAll(t).length; });
      const allClasses = [...new Set([...document.querySelectorAll('a[href*="sneakernews.com/20"]')].map(a => a.closest('[class]')?.className?.split(' ')[0]).filter(Boolean))].slice(0, 10);
      return { counts, allClasses, firstLink: document.querySelector('a[href*="sneakernews.com/20"]')?.closest('[class]')?.outerHTML?.slice(0, 300) };
    });
    console.log('[SN-DEBUG]', JSON.stringify(debugInfo));
      const articles = [];
      const cards = document.querySelectorAll('article, .post, [class*="post-item"], [class*="article-item"]');
      cards.forEach(card => {
        const linkEl = card.querySelector('a[href*="sneakernews.com"]') || card.querySelector('a[href^="/"]');
        let href = linkEl?.href || '';
        if (!href) return;
        if (href.startsWith('/')) href = 'https://sneakernews.com' + href;
        if (!href.includes('sneakernews.com')) return;
        const titleEl = card.querySelector('h1,h2,h3,h4,[class*="title"]');
        const title = (titleEl?.innerText || '').trim().split('\n')[0].trim();
        if (!title || title.length < 5) return;
        const imgEl = card.querySelector('img');
        const image = imgEl?.src?.startsWith('http') ? imgEl.src
          : (imgEl?.dataset?.src || imgEl?.dataset?.lazySrc || imgEl?.srcset?.split(' ')[0] || null);
        const timeEl = card.querySelector('time');
        const date = timeEl?.getAttribute('datetime') || timeEl?.innerText?.trim() || '';
        articles.push({ source: 'sneakernews', sourceName: 'Sneaker News', title, description: '', link: href, date, image: image || null });
      });
      const seen = new Set();
      return articles.filter(a => { if (seen.has(a.link)) return false; seen.add(a.link); return true; }).slice(0, 40);
    });

    console.log(`Sneaker News Playwright: ${results.length} items`);

    // For any missing images, fetch og:image via Playwright page
    const needsImg = results.filter(a => !a.image).slice(0, 10);
    for (const a of needsImg) {
      const imgPage = await browser.newPage();
      try {
        await imgPage.goto(a.link, { waitUntil: 'domcontentloaded', timeout: 15000 });
        const img = await imgPage.evaluate(() => {
          const el = document.querySelector('meta[property="og:image"]');
          return el?.content || null;
        });
        if (img?.startsWith('http') && !img.includes('/themes/')) a.image = img;
      } catch(e) { /* skip */ } finally { await imgPage.close(); }
    }

    if (results.length > 0) return results;
  } catch(e) { console.error('Sneaker News Playwright error:', e.message); }
  finally { await page.close(); }
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
    const items = feed.items?.slice(0, 40) || [];
    const articles = items.map((item, i) => {
      const img = extractImage(item) || preExtracted[i]?.image || null;
      const isPlaceholder = (url) => !url || /ksfin|placeholder|default-img|blank|wp-content\/themes/i.test(url) || url.startsWith('data:');
      return {
        source: 'sneakernews', sourceName: 'Sneaker News',
        title: item.title || '',
        description: item.contentSnippet || preExtracted[i]?.description || '',
        link: item.link || '', date: item.pubDate || item.isoDate || '',
        image: isPlaceholder(img) ? null : img
      };
    });
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
    const items = feed.items?.slice(0, 40) || [];
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
      const isStyle = section.includes('/style');
      try {
        await page.setExtraHTTPHeaders({ 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });
        await page.goto(section, { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (isStyle) {
          try { await page.waitForSelector('[class*="MegaFeedCardContainer"]', { timeout: 8000 }); } catch(e) { /* fallback to timeout */ await page.waitForTimeout(4000); }
        } else {
          await page.waitForTimeout(2500);
        }
        return await page.evaluate((isStyle) => {
          const results = [];
          // Parse "1 HOUR AGO", "2 HOURS AGO", "3 DAYS AGO" etc into ISO date string
          function parseRelativeTime(str) {
            if (!str) return '';
            const m = str.match(/(\d+)\s+(MINUTE|HOUR|DAY|WEEK)S?\s+AGO/i);
            if (!m) return '';
            const n = parseInt(m[1]);
            const unit = m[2].toUpperCase();
            const ms = { MINUTE: 60000, HOUR: 3600000, DAY: 86400000, WEEK: 604800000 }[unit] || 0;
            return new Date(Date.now() - n * ms).toISOString();
          }
          if (isStyle) {
            // Style page: MegaFeedCardContainer has innerText like "STYLE\n\nTitle Here\n\nDescription\n\nAuthor\nTime"
            document.querySelectorAll('[class*="MegaFeedCardContainer"]').forEach(card => {
              const articleLink = Array.from(card.querySelectorAll('a[href]')).find(a => /complex\.com\/style\/a\//.test(a.href));
              if (!articleLink) return;
              const href = articleLink.href;
              const lines = card.innerText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
              const title = lines.find(l => l.length > 15 && !/^(STYLE|SNEAKERS|MUSIC|POP CULTURE|SPORTS|\d+ (HOURS?|DAYS?|MINUTES?|WEEKS?) AGO)$/i.test(l)) || '';
              if (!title || title.length < 10) return;
              // Last line is usually the time string
              const timeLine = lines[lines.length - 1] || '';
              const date = parseRelativeTime(timeLine);
              const img = card.querySelector('img');
              const imgSrc = img?.src?.startsWith('http') ? img.src
                : img?.dataset?.src?.startsWith('http') ? img.dataset.src
                : img?.dataset?.lazySrc?.startsWith('http') ? img.dataset.lazySrc
                : img?.srcset ? img.srcset.split(',')[0].trim().split(' ')[0]
                : null;
              results.push({ source: 'complex', sourceName: 'Complex', title, description: '', link: href, date, image: imgSrc || null });
            });
          } else {
            // Sneakers page: original logic untouched
            document.querySelectorAll('a[href]').forEach(a => {
              const href = a.href || '';
              if (!href.includes('complex.com')) return;
              if (!href.match(/complex\.com\/(sneakers|style|music|pop-culture|sports)\/(a\/)?[a-z0-9-]/)) return;
              const lines = a.innerText.trim().split('\n').map(l => l.trim()).filter(l => l.length > 15);
              const title = lines[0] || '';
              if (!title || title.length < 10) return;
              const card = a.closest('article,[class*="card"],[class*="item"],[class*="post"]');
              const timeEl = card ? card.querySelector('time') : null;
              const img = card ? card.querySelector('img') : null;
              results.push({ source: 'complex', sourceName: 'Complex', title, description: '', link: href, date: timeEl ? (timeEl.getAttribute('datetime') || '') : '', image: img?.src?.startsWith('http') ? img.src : null });
            });
          }
          const seen = new Set();
          return results.filter(a => { if (seen.has(a.title)) return false; seen.add(a.title); return true; });
        }, isStyle);
      } catch(e) { console.error('Complex section error:', e.message); return []; }
      finally { await page.close(); }
    }));

    const allResults = sectionResults.flat();
    const seen = new Set();
    const deduped = allResults.filter(a => { if (seen.has(a.title)) return false; seen.add(a.title); return true; });

    // If style articles are missing, try rss2json as fallback
    const styleCount = deduped.filter(a => a.link && a.link.includes('/style/')).length;
    console.log(`Complex: ${deduped.length} total, ${styleCount} style articles`);
    if (styleCount === 0) {
      console.log('Complex style: Playwright got 0 style articles, trying rss2json fallback...');
      const styleFeeds = [
        'https://www.complex.com/style/rss',
        'https://www.complex.com/style/feed',
        'https://assets.complex.com/feeds/channels/style.xml',
        'https://assets.complex.com/feeds/channels/style-feed.xml',
      ];
      for (const feedUrl of styleFeeds) {
        const r2j = await fetchViaRss2json(feedUrl, 'complex', 'Complex').catch(() => null);
        if (r2j && r2j.length > 0) {
          console.log(`Complex style via rss2json (${feedUrl}): ${r2j.length} items`);
          deduped.push(...r2j.slice(0, 15));
          break;
        }
        const direct = await fetchDirectFeed(feedUrl, 'complex', 'Complex').catch(() => null);
        if (direct && direct.length > 0) {
          console.log(`Complex style via direct feed (${feedUrl}): ${direct.length} items`);
          deduped.push(...direct.slice(0, 15));
          break;
        }
      }
    }


    const final = deduped.slice(0, 60);
    // Fetch og:meta for articles missing date or image (cap at 15)
    const needsMeta = final.filter(a => !a.date || !a.image).slice(0, 15);
    await Promise.allSettled(needsMeta.map(async (a) => {
      const meta = await fetchOgMeta(a.link);
      if (meta.image && !a.image) a.image = meta.image;
      if (meta.date && !a.date) a.date = meta.date;
    }));
    console.log('Complex scraped: ' + final.length + ' items');
    return final;
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
      return results.filter(a => { if (seen.has(a.link)) return false; seen.add(a.link); return true; }).slice(0, 40);
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
        return feed.items?.slice(0, 40).map(item => ({
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

  // Wrap the entire fetch in a timeout so it can never hang forever
  const FETCH_TIMEOUT = 120000; // 2 minutes max

  fetchInProgress = (async () => {
    console.log('Fetching all feeds...');
    let browser;
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('fetchAllFeeds timed out after 2 minutes')), FETCH_TIMEOUT);
    });

    try {
      const fetchWork = (async () => {
      // RSS/fetch sources — fire immediately, run in parallel with Playwright work
      const rssPromise = Promise.allSettled([
        fetchSneakerNews(), fetchJustFreshKicks(), fetchSoleRetriever(), fetchWWD()
      ]);

      // Single Chromium for all Playwright scrapers — pages run sequentially
      browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
      const hypeArticles       = await fetchHypebeast(browser).catch(e => { console.error('Hypebeast failed:', e.message); return []; });
      const highsnobArticles   = await fetchHighsnobiety(browser).catch(e => { console.error('Highsnobiety failed:', e.message); return []; });
      const complexArticles    = await fetchComplex(browser).catch(e => { console.error('Complex failed:', e.message); return []; });
      const mnArticles         = await fetchModernNotoriety(browser).catch(e => { console.error('MN failed:', e.message); return []; });
      const snPlaywrightArticles = await fetchSneakerNewsPlaywright(browser).catch(e => { console.error('SN Playwright failed:', e.message); return []; });

      // Close browser before awaiting RSS to free memory while we wait
      await browser.close(); browser = null;

      // Await RSS results + enrich WWD images in parallel (WWD has no images in RSS feed)
      const [rssResults] = await Promise.all([
        rssPromise,
        Promise.resolve()
      ]);
      const [sneakernews, justfreshkicks, soleretriever, wwd] = rssResults;

      const wwdArticles = wwd.status === 'fulfilled' ? wwd.value : [];
      const wwdImagePromise = Promise.allSettled(wwdArticles.map(async (a) => {
        const meta = await fetchOgMeta(a.link);
        if (meta.image) a.image = meta.image;
      }));
      const snArticles = snPlaywrightArticles.length > 0
        ? snPlaywrightArticles
        : (sneakernews.status === 'fulfilled' ? sneakernews.value : []);
      const articles = [
        ...hypeArticles,
        ...highsnobArticles,
        ...snArticles,
        ...(justfreshkicks.status === 'fulfilled' ? justfreshkicks.value : []),
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
      // Prefer cached version if it has a description (AI summary), otherwise use fresh scrape
      const cachedByLink = new Map(cachedArticles.map(a => [a.link, a]));
      const newArticles = articles.filter(a => !seenUrls.has(a.link) || cachedByLink.has(a.link));

      // Merge: for each article, keep the version with the most data
      const merged = [];
      const mergedLinks = new Set();
      for (const a of newArticles) {
        const cached = cachedByLink.get(a.link);
        if (cached && cached.description && !a.description) {
          // Cached version has AI summary, fresh scrape doesn't — keep cached but update image/date if needed
          if (a.image && !cached.image) cached.image = a.image;
          if (a.date && (!cached.date || new Date(a.date) > new Date(cached.date))) cached.date = a.date;
          merged.push(cached);
        } else {
          merged.push(a);
        }
        mergedLinks.add(a.link);
      }
      for (const a of cachedArticles) {
        if (!mergedLinks.has(a.link)) {
          merged.push(a);
          mergedLinks.add(a.link);
        }
      }
      // Always include persisted manual articles (they're not in any feed)
      for (const a of manualArticles) {
        if (!mergedLinks.has(a.link)) {
          merged.push(a);
          mergedLinks.add(a.link);
        }
      }
      merged.sort((a, b) => {
        const da = a.date ? new Date(a.date).getTime() : 0;
        const db = b.date ? new Date(b.date).getTime() : 0;
        return (isNaN(db) ? 0 : db) - (isNaN(da) ? 0 : da);
      });

      const added = markUrlsSeen(articles);
      pruneSeenUrls();

      // Generate AI summaries for ANY articles missing descriptions
      await enrichWithSummaries(merged);

      console.log(`Fetch complete: ${added} new URLs this cycle, ${merged.length} total in cache`);

      cachedArticles = archiveOverflow(merged).slice(0, 300);
      lastFetch = Date.now();
      return cachedArticles;
      })(); // end fetchWork

      // Race between actual work and timeout
      const result = await Promise.race([fetchWork, timeoutPromise]);
      clearTimeout(timeoutId);
      return result;
    } catch(e) {
      clearTimeout(timeoutId);
      console.error('fetchAllFeeds:', e.message);
      return cachedArticles;
    }
    finally { if (browser) { try { await browser.close(); } catch(_) {} } fetchInProgress = null; }
  })();
  return fetchInProgress;
}

// ─── YouTube Videos ──────────────────────────────────────────────────────────
const YOUTUBE_CHANNELS = [
  '2cool2Blog', '8oone', '9MagTV', '99percentis', '1981EST', 'aaronmaldonado4070', 'AaronnRamirez', 'AbstractBlack',
  'AcneStudiosOfficial', 'ACSSneakers', 'adidas', 'adidasOriginals', 'Advisry', 'a_eon.16', 'againstlab', 'aimeleondore',
  'lordzevallos', 'allurbancentral', 'AmokKidz', 'Apple', 'Archdigest', 'asspizza730', 'atozy', 'Babylon_la',
  'balenciaga', 'BAPEOFFICIAL', 'bapetown', 'basketcase.gallery', 'BeforeTheyWereFamous', 'benjaminkickz', 'beyondkickspodcast', 'bidstitch',
  'biggestbroentertainment', 'blazendary', 'TheSandboxLA', 'BlissFoster', 'bradhallshoes', 'BrainDeadStudios', 'CPCompanyOfficial', 'CamcorderBanks',
  'Camskicksofficial', 'CanadaGoose', 'PNCINTL', 'casualfridays', 'ChanceDubinick', 'Channel5Clips', 'Channel5YouTube', 'charlieturner7447',
  'Dior', 'CIERAPARKER', 'CodeGreen7', 'Coffeezilla', 'coldfact4618', 'TheCommonHype', 'Complex', 'Complexnews',
  'cono', 'converse', 'CookiesNKicks', 'coolkicks', 'corduroyhills3165', 'creative_ambiance', 'CrepProtect', 'CreteNailPaint',
  'Crumb', 'Cuffem', 'Cut2TheChaseTV', 'imdanielsimmons', 'DayJones', 'DeadstockApp', 'Deeswishyt', 'KARIUKIDENIED',
  'CoughSyrupByDestoDubb', 'DevanOnDeck', 'dickieslife1719', 'dimemtl4051', 'district7arcata883', 'DJAkademiksTV2', 'LateNightCreep', 'DolceGabbana',
  'DoronStudio', 'DramaAlert', 'driptank1406', 'Dripsee', 'Dusted1', 'eBay', 'elliotpage_', 'emmarogue',
  'EmmanuelxBoateng', 'ethanruiz3344', 'EuphoricSupply', 'EvanLidz', 'ExploreWithUs', 'FamousLife', 'FamousNewsBTWF', 'FashionChannel',
  'FashionRoadman', 'fashionlover4', 'fern-tv', 'designerclothes21', 'FFChannel_Official', 'fhtv', 'Finaius', 'FirstWeFeast',
  'fitsfromthestreetst', 'FlyWithJohnnyThai', 'footwearnews', 'OfficialFKZTv', 'fourteenthavenue4100', 'FrugalAesthetic', 'FTP', 'FULLSENDPODCAST',
  'fullsendpodcastclips', 'FULLERMOE', 'g-shocksingapore3788', 'Gallucks', 'Gap', 'GearedTowardGear', 'ghettorunways', 'giftedhater3087',
  'givenchychannel', 'GloTelevision', 'golflefleur', 'GolfMediaApp', 'golfcartmedia', 'GQVideos', 'Grishuhh', 'staygroundead',
  'gtvision3897', 'gucci', 'hamcus603', 'HarrisonNevel', 'heavensneakershop', 'HELIOTEMIL', 'HellstarTV', 'hiddenny5262',
  'highsnobiety', 'hollywire', 'HollywoodLife', 'HYPEBEAST', 'iamriop', 'i-D', 'Icebox', 'IDEAGENERATIONOFFICIAL',
  'IDNTV1', 'IFCFACTORY', 'TheInkus', 'InternetAnarchist', 'InternetHistorian', 'starrlife', 'whoisjacov', 'kustoo',
  'jadenxmonroe', 'JadonGrundy', 'jaredmuros', 'JAMARISPEAKS', 'JayCeeYG', 'jeanpaulgaultier', 'JiDion', 'johnandrew00',
  'JoonTheKing', 'Jordan-Free', 'JoshDominic', 'JumperManKris', 'JustClipsone', 'kswiss', 'kaceylynch864', 'Kaiandif',
  'kaimind3', 'keezytv7854', 'KeithAdam', 'iwantvag69', 'KEXNNNN', 'KerwinFrostTV', 'KickGame', 'KidSuper',
  'KiraTV1', 'KyronWarrick', 'Lacoste', 'LainiOzark', 'LamboAndy', 'LivingProofNewYork', 'LocustAndWildHoney', 'Loewe',
  'louisvuitton', 'LOWHEADSMedia', 'LOWluxury', 'machecustoms6516', 'madeyoulooks', 'MagnatesMedia', 'MagnusRonning1', 'MAISONKIMHEKIM',
  'MaisonMargiela', 'marketstudios', 'MENACELOSANGELES', 'MISBHV_ClubWearSolutions', 'mnmlla', 'modernnotoriety', 'MONTREALITY', 'mrfoamersimpson',
  'MyClothingArchive', 'NachoAverageFinds', 'nardwuar', 'Imnathgriff', 'neckfacetv', 'neoexplains', 'newera', 'Newsthink',
  'nicekicks', 'nigelsylvesterlive', 'nigo4767', 'nike', 'nikesb', 'NoDiploma', 'nonbiased', 'norffstudios',
  'trippingishere', 'Notre-shop', 'nowfashion', 'OfficeOneEleven', 'onthecomeupdawn3695', 'onlygeo', 'OrchardClothing888', 'OrdinaryThings',
  'OurGenerationMusic', 'PacsunOfficial', 'PALACESKATEBOARDSLONDON', 'PapaMeat', 'PAQofficial', 'PASSPORTSKATEBOARDS', 'PatCc', 'patnmoon',
  'PatrickCc', 'MrPaulCantu', 'PaulSoles212', 'PaydayPickups', 'pitchfork', 'PlacesPlusFaces', 'PoetikFlakko', 'JeremyJones',
  'privateconversations', 'PublishX', 'PUMA', 'push_product', 'razer', 'REESECOOPER', 'osamachabbi', 'richiele',
  'riot__hill', 'robprsa', 'RobertLoyale', 'RoundTwo', 'RTFKTstudios', 'ryderradio', 'yvessaintlaurent', 'salehebembury',
  'Sangiev', 'seaggs', 'SethFowler', 'Seytonic', 'ShadeTV247', 'sidetalknyc', 'skysportswear', 'slow_start',
  'SmallFeetBigHeat', 'SneakCity', 'sneakerstocks6865', 'sneakerhen', 'SneakerPhetish', 'SneakerTalk', 'SNKRINC', 'sohtaro',
  'SoleCollector', 'Spectacles', 'SpillPlug', 'SteveCroteauPeepGame', 'steviesalle', 'stewarthicks', 'StockX', 'StormShadowCrew',
  'stussyjapanvideo', 'StussyVideo', 'SuapsYT', 'SubwayOracle', 'sunday', 'SunnyV2', 'supereight', 'superlinewholesale',
  'SupThomas', 'TAZS', 'berrics', 'THECASUALco', 'thedailystardust', 'TheHollywoodFix', 'thehundreds', 'TheNorthFace',
  'TheSecondLoft', 'TheShoeSurgeon', 'ThisIsAntwon', 'Threaducation', 'ThriftCon', 'ThrowingFits', 'TimDessaint', 'TommyHilfiger',
  'ToNYD2WiLD', 'Topps', 'trevorgorji', 'TristanWick', 'understitchYT', 'undiscoveredyt', 'unionlosangeles435', 'vans',
  'VETEMENTSOFFICIAL', 'VICE-TV', 'virgilabloh', 'VisualVenture', 'VivetOfficial', 'Vogue', 'Volksgeist', 'wavywebsurf',
  'WMTVLDN', 'WearTesters', 'welcomejpeg', 'WhatsTheHype.Landon', 'Gwhip', 'whodecideswar4982', 'hiphoptvwhy', 'wrong_trousers',
  'x17online', 'XLARGEOFFICIAL', 'YourMultimedia', 'YOUTHSINBALACLAVA'
];

let cachedVideos = [];
let lastVideosFetch = 0;
const VIDEOS_TTL = 30 * 60 * 1000; // 30 minutes
let videosRefreshing = false;

// Resolve @handle to channel ID by fetching the channel page
const channelIdCache = new Map();
const CHANNEL_ID_FILE = path.join(__dirname, 'channel-ids.json');

function loadChannelIds() {
  try {
    if (fs.existsSync(CHANNEL_ID_FILE)) {
      const data = JSON.parse(fs.readFileSync(CHANNEL_ID_FILE, 'utf8'));
      for (const [k, v] of Object.entries(data)) channelIdCache.set(k, v);
      console.log(`Loaded ${channelIdCache.size} cached channel IDs`);
    }
  } catch(e) {}
}
function saveChannelIds() {
  try {
    fs.writeFileSync(CHANNEL_ID_FILE, JSON.stringify(Object.fromEntries(channelIdCache)), 'utf8');
  } catch(e) {}
}
loadChannelIds();

async function resolveChannelId(handle) {
  if (channelIdCache.has(handle)) return channelIdCache.get(handle);
  try {
    const res = await fetch(`https://www.youtube.com/@${handle}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(10000)
    });
    const html = await res.text();
    // Extract channel ID from meta tag or canonical URL
    const match = html.match(/channel_id=([A-Za-z0-9_-]+)/)
      || html.match(/"channelId":"([A-Za-z0-9_-]+)"/)
      || html.match(/youtube\.com\/channel\/([A-Za-z0-9_-]+)/);
    if (match) {
      channelIdCache.set(handle, match[1]);
      saveChannelIds();
      return match[1];
    }
  } catch(e) { console.error(`Failed to resolve @${handle}:`, e.message); }
  return null;
}

async function fetchAllVideos() {
  if (videosRefreshing) return;
  videosRefreshing = true;
  console.log('Fetching YouTube videos...');
  try {
    const videoParser = new Parser({
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });

    // Resolve all handles to channel IDs (batch in parallel for speed)
    const channelIds = [];
    for (let i = 0; i < YOUTUBE_CHANNELS.length; i += 20) {
      const batch = YOUTUBE_CHANNELS.slice(i, i + 20);
      const results = await Promise.allSettled(batch.map(h => resolveChannelId(h)));
      results.forEach((r, idx) => {
        if (r.status === 'fulfilled' && r.value) {
          channelIds.push({ handle: batch[idx], id: r.value });
        }
      });
    }
    console.log(`Resolved ${channelIds.length}/${YOUTUBE_CHANNELS.length} channel IDs`);

    // Fetch all RSS feeds in parallel (batches of 20)
    const allVideos = [];
    for (let i = 0; i < channelIds.length; i += 20) {
      const batch = channelIds.slice(i, i + 20);
      const results = await Promise.allSettled(
        batch.map(async ({ handle, id }) => {
          try {
            const feed = await videoParser.parseURL(
              `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`
            );
            const channelName = feed.title ? feed.title.replace(/ - Topic$/, '') : handle;
            return (feed.items || []).slice(0, 10).map(item => ({
              title: item.title || '',
              link: item.link || '',
              date: item.pubDate || item.isoDate || '',
              channel: channelName,
              channelHandle: handle,
              thumbnail: `https://i.ytimg.com/vi/${(item.id || '').replace('yt:video:', '')}/hqdefault.jpg`,
              videoId: (item.id || '').replace('yt:video:', '')
            }));
          } catch(e) {
            return [];
          }
        })
      );
      for (const r of results) {
        if (r.status === 'fulfilled') allVideos.push(...r.value);
      }
    }

    // Sort by date (newest first)
    allVideos.sort((a, b) => {
      const da = a.date ? new Date(a.date).getTime() : 0;
      const db = b.date ? new Date(b.date).getTime() : 0;
      return (isNaN(db) ? 0 : db) - (isNaN(da) ? 0 : da);
    });

    // Deduplicate by video ID
    const seen = new Set();
    const unique = allVideos.filter(v => {
      if (!v.videoId || seen.has(v.videoId)) return false;
      seen.add(v.videoId);
      return true;
    });

    if (unique.length > 0) {
      cachedVideos = archiveVideoOverflow(unique).slice(0, 300);
      lastVideosFetch = Date.now();
      console.log(`Videos: ${cachedVideos.length} total from ${channelIds.length} channels`);
    }
  } catch(e) {
    console.error('Video fetch error:', e.message);
  } finally {
    videosRefreshing = false;
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Redirect www to non-www and ensure HTTPS (belt-and-suspenders with Cloudflare)
app.use((req, res, next) => {
  const host = req.headers.host || '';
  if (host.startsWith('www.')) {
    return res.redirect(301, 'https://streetwear.news' + req.url);
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  maxAge: '7d', // Cache static assets (CSS, JS, fonts, images) for 7 days
  etag: true
}));

// Critical bot files — must respond instantly, before any heavy routes
app.get('/robots.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send('User-agent: *\nAllow: /\nSitemap: https://streetwear.news/sitemap.xml');
});

app.get('/ads.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send('google.com, pub-6720370763893882, DIRECT, f08c47fec0942fa0');
});

// Health check — use with UptimeRobot or similar to monitor and keep container warm
app.get('/healthz', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    articles: cachedArticles.length,
    lastFetch: lastFetch ? new Date(lastFetch).toISOString() : null
  });
});

app.get('/api/articles', (req, res) => {
  // Always respond instantly with whatever is cached
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  res.json({ articles: cachedArticles, lastFetch });
  // If cache is stale, kick off background refresh (don't await — user already has response)
  if (Date.now() - lastFetch > CACHE_TTL) {
    fetchAllFeeds().catch(console.error);
  }
});

app.get('/api/featured', (req, res) => {
  res.json({ featured: featuredArticles });
});

app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json({ articles: [] });
  const inMemory = cachedArticles.filter(a =>
    (a.title||'').toLowerCase().includes(q) || (a.description||'').toLowerCase().includes(q)
  );
  const inMemoryLinks = new Set(inMemory.map(a => a.link));
  const inArchive = articleArchive.filter(a =>
    !inMemoryLinks.has(a.link) &&
    ((a.title||'').toLowerCase().includes(q) || (a.description||'').toLowerCase().includes(q))
  );
  res.json({ articles: [...inMemory, ...inArchive] });
});

app.get('/api/ticker', (req, res) => {
  res.json({ text: tickerText });
});

app.get('/api/votes', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.json({ votes: votesData });
});

app.post('/api/vote', express.json(), (req, res) => {
  const { url, direction } = req.body;
  if (!url || !['up', 'down'].includes(direction)) return res.status(400).json({ error: 'Invalid' });
  if (!votesData[url]) votesData[url] = { up: 0, down: 0 };
  votesData[url][direction] = (votesData[url][direction] || 0) + 1;
  saveVotes();
  res.json({ success: true, votes: votesData[url] });
});

app.post('/api/unvote', express.json(), (req, res) => {
  const { url, direction } = req.body;
  if (!url || !['up', 'down'].includes(direction)) return res.status(400).json({ error: 'Invalid' });
  if (!votesData[url]) votesData[url] = { up: 0, down: 0 };
  votesData[url][direction] = Math.max(0, (votesData[url][direction] || 0) - 1);
  saveVotes();
  res.json({ success: true, votes: votesData[url] });
});

app.get('/api/videos', async (req, res) => {
  // Always return cache instantly
  if (cachedVideos.length > 0) {
    res.json({ videos: cachedVideos });
    if (Date.now() - lastVideosFetch >= VIDEOS_TTL) {
      fetchAllVideos(); // refresh in background
    }
    return;
  }
  // First request with empty cache
  await fetchAllVideos();
  res.json({ videos: cachedVideos });
});

app.get('/videos', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'videos.html'));
});

app.get('/watch', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'watch.html'));
});

app.post('/api/subscribe', express.json(), (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Invalid email' });
  if (emailSubscribers.includes(email)) return res.json({ success: true }); // already subscribed
  emailSubscribers.push(email);
  saveEmails();
  console.log('New subscriber:', email);
  res.json({ success: true });
});

// ─── Upcoming Drops (scraped from Sole Retriever) ─────────────────────────────
let cachedDrops = [];
let lastDropsFetch = 0;
const DROPS_TTL = 60 * 60 * 1000; // 1 hour
let dropsRefreshing = false;

async function refreshDropsInBackground() {
  if (dropsRefreshing) return; // prevent overlapping scrapes
  dropsRefreshing = true;
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    const allDrops = [];
    const MAX_PAGES = 5;

    for (let p = 1; p <= MAX_PAGES; p++) {
      const url = p === 1
        ? 'https://www.soleretriever.com/sneaker-release-dates'
        : `https://www.soleretriever.com/sneaker-release-dates?page=${p}`;

      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(3000);

        const pageDrops = await page.evaluate(() => {
          const results = [];
          const allLinks = document.querySelectorAll('a[href*="/sneakers/"]');
          let cards = [];

          for (const link of allLinks) {
            const text = (link.innerText || '').trim();
            const hasImage = !!link.querySelector('img');
            const hasPrice = /\$\d/.test(text) || /price tbd/i.test(text);
            const hasDate = /(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}/i.test(text)
                         || /\d{4}/.test(text) || /holiday/i.test(text);
            if (hasImage && (hasPrice || hasDate)) {
              cards.push(link);
            }
          }

          if (cards.length < 3) {
            for (const container of document.querySelectorAll('div, section, ul')) {
              const children = Array.from(container.children);
              if (children.length >= 5) {
                const releaseCards = children.filter(c => {
                  const t = (c.innerText || '');
                  return c.querySelector('img') && (/\$\d/.test(t) || /20\d{2}/.test(t));
                });
                if (releaseCards.length >= 3) { cards = releaseCards; break; }
              }
            }
          }

          for (const card of cards.slice(0, 60)) {
            try {
              const img = card.querySelector('img');
              const link = card.tagName === 'A' ? card : (card.closest('a') || card.querySelector('a'));
              const allText = (card.innerText || '').trim();
              if (!allText || allText.length < 3) continue;
              const lines = allText.split('\n').map(l => l.trim()).filter(Boolean);

              const priceMatch = allText.match(/\$\d[\d,]*/);
              const dateMatch = allText.match(/(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:[,\s]+\d{4})?/i)
                || allText.match(/Holiday\s+\d{4}/i);

              const skipWords = ['upcoming', 'released', 'price tbd', 'releases'];
              let name = '';
              for (const line of lines) {
                const lower = line.toLowerCase();
                if (line.length > 5
                    && !lower.match(/^\$/)
                    && !skipWords.includes(lower)
                    && !lower.match(/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i)
                    && !lower.match(/^(january|february|march|april|may|june|july|august|september|october|november|december)/i)
                    && !lower.match(/^holiday/i)
                    && line.length < 120
                    && line.length > name.length) {
                  name = line;
                }
              }
              if (!name && lines.length > 0) name = lines[0];
              if (!name || name.length < 4) continue;

              const cleanPrice = priceMatch ? priceMatch[0] : (/price tbd/i.test(allText) ? 'TBD' : '');

              results.push({
                name: name.slice(0, 100),
                image: img ? (img.src || img.dataset?.src || '') : '',
                date: dateMatch ? dateMatch[0] : '',
                price: cleanPrice,
                link: link ? link.href : ''
              });
            } catch(e) {}
          }
          return results;
        });

        allDrops.push(...pageDrops);
        console.log(`Drops page ${p}: found ${pageDrops.length} items (total: ${allDrops.length})`);

        if (pageDrops.length === 0) break;

      } catch(pageErr) {
        console.error(`Drops page ${p} error:`, pageErr.message);
        break;
      }
    }

    await browser.close();
    browser = null;

    // Deduplicate
    const seen = new Set();
    const unique = allDrops.filter(d => {
      const key = d.name.toLowerCase().replace(/\s+/g, ' ').trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (unique.length > 0) {
      cachedDrops = unique;
      lastDropsFetch = Date.now();
      console.log(`Drops: ${cachedDrops.length} total items scraped across ${MAX_PAGES} pages`);
    }
  } catch(e) {
    console.error('Drops Playwright error:', e.message);
    if (browser) { try { await browser.close(); } catch(_) {} }
    // Fallback: try RSS
    try {
      const parser = new Parser();
      const feed = await parser.parseURL('https://www.soleretriever.com/feed');
      const rssDrops = feed.items.slice(0, 30).map(item => ({
        name: item.title || 'Unknown',
        image: (item.enclosure && item.enclosure.url) || '',
        date: item.pubDate ? new Date(item.pubDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '',
        price: '',
        link: item.link || ''
      }));
      if (rssDrops.length > 0) {
        cachedDrops = rssDrops;
        lastDropsFetch = Date.now();
        console.log(`Drops: ${cachedDrops.length} items via RSS fallback`);
      }
    } catch(rssErr) {
      console.error('Drops RSS fallback error:', rssErr.message);
    }
  } finally {
    dropsRefreshing = false;
  }
}

app.get('/api/drops', async (req, res) => {
  // Always return cache instantly — never make visitors wait
  if (cachedDrops.length > 0) {
    res.json({ drops: cachedDrops });
    // If stale, refresh in background
    if (Date.now() - lastDropsFetch >= DROPS_TTL) {
      refreshDropsInBackground();
    }
    return;
  }
  // First ever request with empty cache — scrape now
  await refreshDropsInBackground();
  res.json({ drops: cachedDrops });
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


// ─── Admin: manually add a single article by URL ─────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'sw-admin-2026';

app.use(express.json());

app.options('/admin/add-article', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

// Step 1: fetch metadata from URL (returns partial data even if site blocks)
app.post('/admin/fetch-meta', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { url, password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  if (!url || !url.startsWith('http')) return res.status(400).json({ error: 'Invalid URL' });
  if (cachedArticles.some(a => a.link === url)) return res.status(409).json({ error: 'Article already in feed' });
  const hostname = new URL(url).hostname.replace('www.', '');
  const sourceName = hostname.split('.')[0].charAt(0).toUpperCase() + hostname.split('.')[0].slice(1);
  let title = '', description = '', image = '';
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'text/html' }
    });
    const html = await r.text();
    const titleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
                    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)
                    || html.match(/<title[^>]*>([^<]+)<\/title>/i);
    title = titleMatch?.[1]?.trim() || '';
    const descMatch = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
                   || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i)
                   || html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
    description = descMatch?.[1]?.trim() || '';
    // Filter out descriptions that are just URLs
    if (description.startsWith('http://') || description.startsWith('https://')) description = '';
    const imgMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                  || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    image = imgMatch?.[1]?.startsWith('http') ? imgMatch[1] : '';
  } catch(e) { /* fetch failed — return empty fields for manual entry */ }
  res.json({ success: true, title, description, image, sourceName });
});

// Step 2: actually save the article with user-confirmed fields
app.post('/admin/add-article', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { url, password, title, description, image, sourceName, featured, headline, highlightWord, duration } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  if (!url || !url.startsWith('http')) return res.status(400).json({ error: 'Invalid URL' });
  const hostname = new URL(url).hostname.replace('www.', '');
  const article = {
    source: 'manual',
    sourceName: sourceName || hostname.split('.')[0],
    title: title || hostname,
    description: description || '',
    link: url,
    date: new Date().toISOString(),
    image: image || null,
    manual: true
  };
  // Add or update in grid
  const existingIdx = cachedArticles.findIndex(a => a.link === url);
  if (existingIdx >= 0) {
    cachedArticles[existingIdx] = { ...cachedArticles[existingIdx], ...article };
  } else {
    cachedArticles.unshift(article);
    markUrlsSeen([article]);
  }
  // Persist manual article to disk so it survives restarts
  const manualIdx = manualArticles.findIndex(a => a.link === url);
  if (manualIdx >= 0) {
    manualArticles[manualIdx] = article;
  } else {
    manualArticles.push(article);
  }
  saveManualArticles();
  // Add to featured if checkbox was checked
  if (featured) {
    const featuredItem = {
      ...article,
      headline: headline || title || hostname,
      highlightWord: highlightWord || '',
      duration: parseInt(duration) || 6,
      addedAt: new Date().toISOString()
    };
    // Remove existing featured with same URL to avoid duplicates
    featuredArticles = featuredArticles.filter(f => f.link !== url);
    featuredArticles.push(featuredItem);
    saveFeatured();
    console.log('Featured article set:', featuredItem.headline);
  }
  console.log('Manually added article:', article.title);
  res.json({ success: true, article });
});

app.options('/admin/fetch-meta', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

app.post('/admin/unfeature', (req, res) => {
  const { url, password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  featuredArticles = featuredArticles.filter(f => f.link !== url);
  saveFeatured();
  res.json({ success: true });
});

app.post('/admin/update-ticker', (req, res) => {
  const { text, password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  if (!text || !text.trim()) return res.status(400).json({ error: 'Text required' });
  tickerText = text.trim();
  saveTicker();
  res.json({ success: true });
});

app.get('/admin/archive', (req, res) => {
  const password = req.query.password;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  res.json({
    articles: { count: articleArchive.length, items: articleArchive },
    videos: { count: videoArchive.length, items: videoArchive }
  });
});

app.get('/admin', (req, res) => {
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>streetwear.news — Admin</title>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <style>
    * { box-sizing: border-box; }
    body { font-family: sans-serif; background: #0a0a0a; color: #eee; margin: 0; padding: 2rem 1rem; }
    .container { max-width: 620px; margin: 0 auto; display: flex; flex-direction: column; gap: 1.5rem; }
    h1 { font-size: 1.1rem; letter-spacing: 0.1em; color: #CCFF00; margin-bottom: 0.25rem; }
    .box { background: #1a1a1a; border: 1px solid #2a2a2a; padding: 1.5rem; }
    .box-title { font-size: 0.7rem; letter-spacing: 0.12em; text-transform: uppercase; color: #888; margin-bottom: 1rem; padding-bottom: 0.5rem; border-bottom: 1px solid #2a2a2a; }
    label { display: block; font-size: 0.7rem; color: #888; margin-bottom: 0.25rem; letter-spacing: 0.05em; text-transform: uppercase; }
    input, textarea, select { width: 100%; padding: 0.65rem; background: #222; border: 1px solid #333; color: #fff; font-size: 0.9rem; margin-bottom: 0.75rem; font-family: sans-serif; outline: none; }
    input:focus, textarea:focus, select:focus { border-color: #CCFF00; }
    textarea { resize: vertical; min-height: 60px; }
    .btn { width: 100%; padding: 0.75rem; border: none; color: #000; font-size: 0.85rem; font-weight: bold; letter-spacing: 0.08em; cursor: pointer; margin-bottom: 0.5rem; }
    .btn-primary { background: #CCFF00; }
    .btn-primary:hover { background: #fff; }
    .btn-secondary { background: #333; color: #eee; }
    .btn-secondary:hover { background: #444; }
    .btn-danger { background: #FF3D00; color: #fff; width: auto; padding: 0.4rem 0.75rem; font-size: 0.75rem; }
    .btn-danger:hover { background: #ff6b3d; }
    #status { padding: 0.65rem; font-size: 0.85rem; display: none; margin-top: 0.5rem; }
    .success { background: #1a3a1a; border: 1px solid #3a7a3a; color: #7f7; }
    .error { background: #3a1a1a; border: 1px solid #7a3a3a; color: #f77; }
    .info { background: #1a2a3a; border: 1px solid #3a5a7a; color: #7af; }
    #meta-fields { display: none; border-top: 1px solid #2a2a2a; margin-top: 0.5rem; padding-top: 1rem; }
    #img-preview { max-width: 100%; margin-bottom: 0.75rem; display: none; border: 1px solid #2a2a2a; }
    .featured-toggle { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem; cursor: pointer; }
    .featured-toggle input[type=checkbox] { width: auto; margin: 0; cursor: pointer; accent-color: #CCFF00; }
    .featured-toggle span { font-size: 0.8rem; color: #CCFF00; letter-spacing: 0.05em; }
    #featured-options { display: none; background: #111; border: 1px solid #CCFF0033; padding: 1rem; margin-bottom: 0.75rem; }
    .featured-list-item { display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem 0; border-bottom: 1px solid #2a2a2a; }
    .featured-list-item:last-child { border-bottom: none; }
    .featured-list-thumb { width: 48px; height: 36px; object-fit: cover; background: #222; flex-shrink: 0; }
    .featured-list-info { flex: 1; min-width: 0; }
    .featured-list-name { font-size: 0.8rem; color: #eee; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .featured-list-meta { font-size: 0.7rem; color: #888; margin-top: 2px; }
    .pw-row { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
    .pw-row input { margin-bottom: 0; flex: 1; }
    .pw-save { background: #333; border: none; color: #eee; padding: 0 1rem; font-size: 0.75rem; cursor: pointer; white-space: nowrap; }
    .pw-save:hover { background: #444; }
  </style>
</head>
<body>

<!-- Login Gate -->
<div id="loginGate" class="container" style="margin-top:20vh;">
  <h1>STREETWEAR.NEWS — ADMIN</h1>
  <div class="box">
    <div class="box-title">Authentication Required</div>
    <label>Password</label>
    <input type="password" id="loginPw" placeholder="Enter admin password" onkeydown="if(event.key==='Enter')attemptLogin()"/>
    <button class="btn btn-primary" onclick="attemptLogin()">Sign In</button>
    <div id="loginError" style="color:#f77;font-size:0.8rem;margin-top:0.5rem;display:none;">Wrong password.</div>
  </div>
</div>

<!-- Admin Panel (hidden until authenticated) -->
<div class="container" id="adminPanel" style="display:none;">
  <h1>STREETWEAR.NEWS — ADMIN</h1>

  <!-- Add Article -->
  <div class="box">
    <div class="box-title">Add Article</div>
    <label>Article URL</label>
    <input type="url" id="url" placeholder="https://example.com/article..."/>
    <button class="btn btn-secondary" onclick="fetchMeta()">Fetch Article Info</button>

    <div id="meta-fields">
      <img id="img-preview" src="" alt="preview"/>
      <label>Headline (shown in hero if featured)</label>
      <input type="text" id="title" placeholder="Article title"/>
      <label>Description</label>
      <textarea id="description" placeholder="Short description..."></textarea>
      <label>Image URL (use your own high-res for hero)</label>
      <input type="url" id="image" placeholder="https://..." oninput="previewImg(this.value)"/>
      <label>Source Name</label>
      <input type="text" id="sourceName" placeholder="e.g. Hypebeast"/>

      <label class="featured-toggle">
        <input type="checkbox" id="featuredCheck" onchange="toggleFeaturedOptions()"/>
        <span>⭐ Feature this article as hero</span>
      </label>

      <div id="featured-options">
        <label>Highlight Word (the neon outlined word in headline)</label>
        <input type="text" id="highlightWord" placeholder="Auto-picks longest word — override here"/>
        <label>Hero Duration</label>
        <select id="duration">
          <option value="2">2 Hours</option>
          <option value="4">4 Hours</option>
          <option value="6" selected>6 Hours</option>
          <option value="8">8 Hours</option>
          <option value="12">12 Hours</option>
          <option value="24">24 Hours</option>
        </select>
      </div>

      <button class="btn btn-primary" id="addBtn" onclick="addArticle()">Add to Feed</button>
    </div>
    <div id="status"></div>
  </div>

  <!-- Featured Articles -->
  <div class="box">
    <div class="box-title">Featured Articles (Hero Carousel)</div>
    <div id="featuredList"><div style="color:#555;font-size:0.8rem;">Loading...</div></div>
  </div>

  <!-- Ticker -->
  <div class="box">
    <div class="box-title">Ticker Text</div>
    <label>Use | to separate multiple segments. Example: SEGMENT ONE | SEGMENT TWO</label>
    <textarea id="tickerText" rows="3" placeholder="POWERED BY STAYGROUNDEAD: THE LATEST IN FASHION, STREETWEAR, CULTURE"></textarea>
    <button class="btn btn-primary" onclick="saveTicker()">Save Ticker</button>
    <div id="tickerStatus" style="display:none;padding:0.5rem;font-size:0.8rem;"></div>
  </div>

</div><!-- end adminPanel -->
<script>
  let adminPassword = '';

  async function attemptLogin() {
    const pw = document.getElementById('loginPw').value.trim();
    if (!pw) return;
    try {
      const r = await fetch('/api/ticker', { headers: {} });
      // Test password by trying a harmless authenticated request
      const test = await fetch('/admin/fetch-meta', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ url: 'https://test.com', password: pw })
      });
      const data = await test.json();
      // 401 = wrong password, 409 = already exists (means password was right), 400 = invalid but authenticated
      if (test.status === 401) {
        document.getElementById('loginError').style.display = 'block';
        return;
      }
      // Password accepted
      adminPassword = pw;
      document.getElementById('loginGate').style.display = 'none';
      document.getElementById('adminPanel').style.display = 'flex';
    } catch(e) {
      // If fetch fails, try showing admin anyway
      adminPassword = pw;
      document.getElementById('loginGate').style.display = 'none';
      document.getElementById('adminPanel').style.display = 'flex';
    }
  }

  function pw() { return adminPassword; }

  // Load ticker current value
  fetch('/api/ticker').then(r=>r.json()).then(d => { document.getElementById('tickerText').value = d.text || ''; });

  // Load featured articles
  async function loadFeatured() {
    const res = await fetch('/api/featured');
    const data = await res.json();
    const list = document.getElementById('featuredList');
    if (!data.featured || data.featured.length === 0) {
      list.innerHTML = '<div style="color:#555;font-size:0.8rem;">No featured articles set.</div>';
      return;
    }
    list.innerHTML = data.featured.map(f => \`
      <div class="featured-list-item">
        \${f.image ? \`<img class="featured-list-thumb" src="\${f.image}" onerror="this.style.display='none'">\` : '<div class="featured-list-thumb"></div>'}
        <div class="featured-list-info">
          <div class="featured-list-name">\${f.headline || f.title}</div>
          <div class="featured-list-meta">\${f.duration}hr slot · \${f.sourceName}</div>
        </div>
        <button class="btn btn-secondary" style="width:auto;padding:0.4rem 0.75rem;font-size:0.75rem;margin:0 0.25rem 0 0;" onclick='editFeatured(\${JSON.stringify(f).replace(/'/g, "&#39;")})'>Edit</button>
        <button class="btn btn-danger" onclick="unfeature('\${f.link.replace(/'/g, "\\\\'")}')">Unfeature</button>
      </div>\`).join('');
  }
  loadFeatured();

  async function unfeature(url) {
    const res = await fetch('/admin/unfeature', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url, password: pw() }) });
    const data = await res.json();
    if (data.success) loadFeatured();
    else alert('Error: ' + (data.error || 'Failed'));
  }

  function editFeatured(f) {
    // Populate the form with existing featured article data
    document.getElementById('url').value = f.link || '';
    document.getElementById('title').value = f.headline || f.title || '';
    document.getElementById('description').value = f.description || '';
    document.getElementById('image').value = f.image || '';
    document.getElementById('sourceName').value = f.sourceName || '';
    document.getElementById('highlightWord').value = f.highlightWord || '';
    document.getElementById('duration').value = String(f.duration || 6);
    document.getElementById('featuredCheck').checked = true;
    document.getElementById('featured-options').style.display = 'block';
    document.getElementById('meta-fields').style.display = 'block';
    if (f.image) previewImg(f.image);
    // Change button text to indicate editing
    document.getElementById('addBtn').textContent = 'Update Article';
    // Scroll to form
    document.getElementById('url').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function saveTicker() {
    const text = document.getElementById('tickerText').value.trim();
    const s = document.getElementById('tickerStatus');
    const res = await fetch('/admin/update-ticker', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text, password: pw() }) });
    const data = await res.json();
    s.style.display = 'block';
    s.style.color = data.success ? '#CCFF00' : '#f77';
    s.textContent = data.success ? '✓ Ticker updated!' : 'Error: ' + data.error;
  }

  function toggleFeaturedOptions() {
    document.getElementById('featured-options').style.display = document.getElementById('featuredCheck').checked ? 'block' : 'none';
  }

  async function fetchMeta() {
    const url = document.getElementById('url').value.trim();
    if (!url) { showStatus('Please enter a URL', 'error'); return; }
    if (!pw()) { showStatus('Please enter your password', 'error'); return; }
    showStatus('Fetching article info...', 'info');
    try {
      const r = await fetch('/admin/fetch-meta', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url, password: pw() }) });
      const data = await r.json();
      if (r.status === 401) { showStatus('Wrong password.', 'error'); return; }
      if (!document.getElementById('title').value) document.getElementById('title').value = data.title || '';
      if (!document.getElementById('description').value) document.getElementById('description').value = data.description || '';
      if (!document.getElementById('image').value) {
        document.getElementById('image').value = data.image || '';
        previewImg(data.image || '');
      }
      if (!document.getElementById('sourceName').value) document.getElementById('sourceName').value = data.sourceName || '';
      // Auto-pick highlight word (longest word in title)
      const words = (data.title || '').split(' ').filter(w => w.length > 3);
      document.getElementById('highlightWord').value = words.length ? words.reduce((a,b) => b.length > a.length ? b : a, '') : '';
      previewImg(data.image || '');
      document.getElementById('meta-fields').style.display = 'block';
      showStatus(data.title ? 'Info fetched! Review and click Add to Feed.' : 'Could not auto-fetch — fill in manually.', 'info');
    } catch(e) {
      document.getElementById('meta-fields').style.display = 'block';
      showStatus('Could not reach site. Fill in manually.', 'info');
    }
  }

  async function addArticle() {
    const url = document.getElementById('url').value.trim();
    const title = document.getElementById('title').value.trim();
    const description = document.getElementById('description').value.trim();
    const image = document.getElementById('image').value.trim();
    const sourceName = document.getElementById('sourceName').value.trim();
    const featured = document.getElementById('featuredCheck').checked;
    const highlightWord = document.getElementById('highlightWord').value.trim();
    const duration = document.getElementById('duration').value;
    if (!title) { showStatus('Please enter a title', 'error'); return; }
    showStatus('Adding...', 'info');
    try {
      const r = await fetch('/admin/add-article', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url, password: pw(), title, description, image, sourceName, featured, headline: title, highlightWord, duration }) });
      const data = await r.json();
      if (data.success) {
        showStatus('✓ Added' + (featured ? ' + Featured!' : '!'), 'success');
        document.getElementById('url').value = '';
        document.getElementById('title').value = '';
        document.getElementById('description').value = '';
        document.getElementById('image').value = '';
        document.getElementById('sourceName').value = '';
        document.getElementById('featuredCheck').checked = false;
        document.getElementById('featured-options').style.display = 'none';
        document.getElementById('meta-fields').style.display = 'none';
        document.getElementById('img-preview').style.display = 'none';
        document.getElementById('addBtn').textContent = 'Add to Feed';
        if (featured) loadFeatured();
      } else { showStatus('Error: ' + data.error, 'error'); }
    } catch(e) { showStatus('Error: ' + e.message, 'error'); }
  }

  function previewImg(src) {
    const el = document.getElementById('img-preview');
    if (src && src.startsWith('http')) { el.src = src; el.style.display = 'block'; }
    else { el.style.display = 'none'; }
  }

  function showStatus(msg, type) {
    const el = document.getElementById('status');
    el.textContent = msg;
    el.className = type;
    el.style.display = 'block';
  }

  document.getElementById('url').addEventListener('keydown', e => { if (e.key === 'Enter') fetchMeta(); });
</script>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});
app.get('/sitemap.xml', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  const brands = ['nike','adidas','supreme','jordan','new-balance','vans','puma','crocs','reebok','palace'];
  const baseUrl = 'https://streetwear.news';
  const today = new Date().toISOString().split('T')[0];
  // Generate last 12 weekly slugs
  const weekSlugs = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date();
    d.setDate(d.getDate() - (d.getDay() + i * 7));
    weekSlugs.push(d.toISOString().split('T')[0]);
  }
  const urls = [
    { loc: baseUrl + '/', changefreq: 'always', priority: '1.0' },
    { loc: baseUrl + '/about', changefreq: 'monthly', priority: '0.5' },
    { loc: baseUrl + '/terms', changefreq: 'yearly', priority: '0.3' },
    { loc: baseUrl + '/privacy', changefreq: 'yearly', priority: '0.3' },
    { loc: baseUrl + '/contact', changefreq: 'yearly', priority: '0.3' },
    { loc: baseUrl + '/advertising', changefreq: 'monthly', priority: '0.4' },
    { loc: baseUrl + '/accessibility', changefreq: 'yearly', priority: '0.3' },
    ...brands.map(b => ({ loc: baseUrl + '/brand/' + b, changefreq: 'hourly', priority: '0.8' })),
    ...weekSlugs.map(s => ({ loc: baseUrl + '/weekly/' + s, changefreq: 'weekly', priority: '0.6' }))
  ];
  const xml = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    urls.map(u => '<url><loc>' + u.loc + '</loc><lastmod>' + today + '</lastmod><changefreq>' + u.changefreq + '</changefreq><priority>' + u.priority + '</priority></url>').join('') +
    '</urlset>';
  res.setHeader('Content-Type', 'application/xml');
  res.send(xml);
});

app.get('/rss.xml', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=600, stale-while-revalidate=60');
  const articles = cachedArticles.slice(0, 20);
  const escape = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const items = articles.map(a => `<item>
    <title>${escape(a.title)}</title>
    <link>${escape(a.link)}</link>
    <description>${escape(a.description)}</description>
    <pubDate>${a.date ? new Date(a.date).toUTCString() : ''}</pubDate>
    <source url="${escape(a.link)}">${escape(a.sourceName)}</source>
  </item>`).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>streetwear.news — Latest Streetwear News &amp; Sneaker Drops</title>
    <link>https://streetwear.news/</link>
    <description>The fastest streetwear news aggregator. Latest drops, collabs, and releases from all major sources.</description>
    <language>en-us</language>
    <atom:link href="https://streetwear.news/rss.xml" rel="self" type="application/rss+xml"/>
    ${items}
  </channel>
</rss>`;
  res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
  res.send(xml);
});

const BRANDS = {
  'nike': { name: 'Nike', keywords: ['nike', 'air max', 'air jordan', 'af1', 'air force', 'dunk', 'blazer', 'cortez'] },
  'adidas': { name: 'Adidas', keywords: ['adidas', 'yeezy', 'ultraboost', 'nmd', 'superstar', 'stan smith', 'forum', 'samba'] },
  'supreme': { name: 'Supreme', keywords: ['supreme'] },
  'jordan': { name: 'Jordan', keywords: ['jordan', 'air jordan', 'jumpman'] },
  'new-balance': { name: 'New Balance', keywords: ['new balance', 'nb ', '990', '991', '992', '993', '2002', '327', '550', '574'] },
  'vans': { name: 'Vans', keywords: ['vans', 'old skool', 'sk8-hi', 'authentic', 'slip-on', 'era '] },
  'puma': { name: 'Puma', keywords: ['puma'] },
  'crocs': { name: 'Crocs', keywords: ['crocs', 'clog'] },
  'reebok': { name: 'Reebok', keywords: ['reebok', 'club c', 'classic leather', 'instapump'] },
  'palace': { name: 'Palace', keywords: ['palace'] }
};

app.get('/brand/:slug', async (req, res) => {
  const slug = req.params.slug.toLowerCase();
  const brand = BRANDS[slug];
  if (!brand) return res.status(404).send('Brand not found');

  if (cachedArticles.length === 0 && fetchInProgress) await fetchInProgress;

  const articles = cachedArticles.filter(a => {
    const text = (a.title + ' ' + (a.description||'')).toLowerCase();
    return brand.keywords.some(kw => text.includes(kw));
  });

  const indexPath = path.join(__dirname, 'public', 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');

  // Update title and meta for brand page
  html = html.replace(
    '<title>Streetwear News, Sneaker Drops &amp; Collabs | streetwear.news</title>',
    '<title>' + brand.name + ' Sneaker News, Drops &amp; Collabs | streetwear.news</title>'
  );
  html = html.replace(
    '<meta name="description"',
    '<meta name="description" content="Latest ' + brand.name + ' sneaker news, drops, and collabs aggregated from Hypebeast, Complex, Sneaker News and more." data-brand-desc/><meta data-orig-desc name="description"'
  );

  // Inject brand schema
  const brandSchema = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    'name': brand.name + ' Sneaker News & Drops',
    'description': 'Latest ' + brand.name + ' sneaker news, drops, and collabs from all major streetwear publications.',
    'url': 'https://streetwear.news/brand/' + slug
  };
  html = html.slice(0, html.indexOf('</head>')) +
    '<script type="application/ld+json">' + JSON.stringify(brandSchema) + '</' + 'script>' +
    html.slice(html.indexOf('</head>'));

  // Pre-render brand articles into grid
  const ssrCards = articles.slice(0, 15).map(a => {
    const t = (a.title||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const d = (a.description||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const l = (a.link||'').replace(/"/g,'&quot;');
    const s = (a.sourceName||'').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const c = (a.source||'').toLowerCase();
    const img = a.image ? '<img class="card-img" src="' + a.image.replace(/"/g,'&quot;') + '" alt="' + t + '" loading="lazy">' : '<div class="card-img-placeholder">' + s + '</div>';
    return '<div class="card"><div class="card-meta"><span class="source-tag ' + c + '">' + s + '</span></div>' + img + '<div class="card-title">' + t + '</div>' + (d ? '<div class="card-desc">' + d + '</div>' : '') + '<a class="card-link" href="' + l + '" target="_blank" rel="noopener">Read Full Article &#8594;</a></div>';
  }).join('');

  const startMarker = '<!-- SSR_GRID_START -->';
  const endMarker = '<!-- SSR_GRID_END -->';
  const startIdx = html.indexOf(startMarker);
  const endIdx = html.indexOf(endMarker);
  if (startIdx !== -1 && endIdx !== -1) {
    const gridTag = '<div class="grid" id="grid">';
    // Add brand heading before grid
    const brandHeading = '<h2 style="padding:1.5rem 2rem 0.5rem;font-family:Bebas Neue,sans-serif;font-size:1.8rem;letter-spacing:0.1em;color:var(--text)">' + brand.name + ' — Latest News &amp; Drops</h2>';
    html = html.slice(0, startIdx) + brandHeading + startMarker + gridTag + ssrCards + '</div>' + html.slice(endIdx + endMarker.length);
  }

  // Inject JSON for client-side filtering
  const jsonData = JSON.stringify(articles);
  const scriptTag = '<script>window.__SSR_ARTICLES__=' + jsonData + ';window.__SSR_BRAND__="' + slug + '";</' + 'script>';
  const headCloseIdx = html.indexOf('</head>');
  if (headCloseIdx !== -1) {
    html = html.slice(0, headCloseIdx) + scriptTag + html.slice(headCloseIdx);
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});


// ─── Static page renderer ─────────────────────────────────────────────────────
function renderStaticPage(title, metaDesc, bodyContent) {
  const indexPath = require('path').join(__dirname, 'public', 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');

  // Update title
  html = html.replace(
    '<title>Streetwear News, Sneaker Drops &amp; Collabs | streetwear.news</title>',
    '<title>' + title + ' | streetwear.news</title>'
  );

  // Inject SSR_ABOUT flag + static content flag into head
  const aboutScript = '<script>window.__SSR_ABOUT__=true;window.__STATIC_PAGE__=true;</' + 'script>';
  const headClose = html.indexOf('</head>');
  if (headClose !== -1) html = html.slice(0, headClose) + aboutScript + html.slice(headClose);

  // Replace grid markers with static content
  const startMarker = '<!-- SSR_GRID_START -->';
  const endMarker = '<!-- SSR_GRID_END -->';
  const startIdx = html.indexOf(startMarker);
  const endIdx = html.indexOf(endMarker);
  const pageContent = '<div class="grid" id="grid" data-static="true"><div style="grid-column:1/-1;padding:3rem 2rem;max-width:800px;color:var(--text);line-height:1.8">' + bodyContent + '</div></div>';
  if (startIdx !== -1 && endIdx !== -1) {
    html = html.slice(0, startIdx) + startMarker + pageContent + html.slice(endIdx + endMarker.length);
  }

  return html;
}

app.get('/about', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');
  html = html.replace(
    '<title>Streetwear News, Sneaker Drops &amp; Collabs | streetwear.news</title>',
    '<title>About streetwear.news — The Fastest Streetwear News Aggregator</title>'
  );
  const startMarker = '<!-- SSR_GRID_START -->';
  const endMarker = '<!-- SSR_GRID_END -->';
  const startIdx = html.indexOf(startMarker);
  const endIdx = html.indexOf(endMarker);
  const aboutContent = '<div class="grid" id="grid"><div style="grid-column:1/-1;padding:3rem 2rem;max-width:700px">' +
    '<h2 style="font-family:Bebas Neue,sans-serif;font-size:2rem;letter-spacing:0.1em;color:var(--accent);margin-bottom:1rem">About streetwear.news</h2>' +
    '<p style="color:var(--text);line-height:1.8;margin-bottom:1rem">streetwear.news is the fastest streetwear news aggregator on the internet. We pull the latest sneaker drops, collab announcements, and streetwear news from the best publications in the game — Hypebeast, Complex, Highsnobiety, Sneaker News, Sole Retriever, WWD, Modern Notoriety, and Just Fresh Kicks — and surface it all in one place, updated every 10 minutes.</p>' +
    '<p style="color:var(--muted);line-height:1.8;margin-bottom:1rem">No more checking 9 different sites. Everything you need to stay ahead of drops, collabs, and culture — right here.</p>' +
    '<p style="color:var(--muted);line-height:1.8"><strong style="color:var(--text)">Sources:</strong> Hypebeast · Complex · Highsnobiety · Sneaker News · Sole Retriever · WWD · Modern Notoriety · Just Fresh Kicks</p>' +
    '</div></div>';
  if (startIdx !== -1 && endIdx !== -1) {
    html = html.slice(0, startIdx) + startMarker + aboutContent + html.slice(endIdx + endMarker.length);
  }
  // Inject flag so JS knows this is the about page
  const aboutScript = '<script>window.__SSR_ABOUT__=true;</' + 'script>';
  const headClose = html.indexOf('</head>');
  if (headClose !== -1) {
    html = html.slice(0, headClose) + aboutScript + html.slice(headClose);
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});


// ─── Terms & Conditions ───────────────────────────────────────────────────────
app.get('/terms', (req, res) => {
  const html = renderStaticPage(
    'Terms & Conditions',
    'Terms and conditions for using streetwear.news, the fastest streetwear news aggregator.',
    `<h2 style="font-family:Bebas Neue,sans-serif;font-size:2rem;letter-spacing:0.1em;color:var(--accent);margin-bottom:1.5rem">Terms &amp; Conditions</h2>
<p style="color:var(--muted);margin-bottom:0.25rem"><strong style="color:var(--text)">Effective Date:</strong> March 15, 2026</p>
<p style="color:var(--muted);margin-bottom:2rem"><strong style="color:var(--text)">Last Updated:</strong> March 15, 2026</p>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">1. Acceptance of Terms</h3>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">By accessing or using the website located at <strong style="color:var(--text)">streetwear.news</strong> (the "Site"), you agree to be bound by these Terms &amp; Conditions ("Terms"). These Terms constitute a legally binding agreement between you ("User," "you," or "your") and <strong style="color:var(--text)">STREETWEAR.NEWS</strong> ("we," "us," or "our"). If you do not agree to these Terms, you must discontinue use of the Site immediately.</p>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">Your continued use of the Site following any updates to these Terms constitutes your acceptance of the revised Terms. We recommend reviewing this page periodically.</p>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">2. Use of the Website</h3>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">2.1 Eligibility</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">The Site is intended for users who are at least 13 years of age. By using the Site, you represent that you are 13 years of age or older. Users under the age of 18 should review these Terms with a parent or guardian.</p>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">2.2 Permitted Use</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">You may access and use the Site for personal, non-commercial informational purposes. You agree to use the Site only in ways that comply with these Terms and all applicable local, state, national, and international laws and regulations.</p>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">2.3 Prohibited Conduct</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">You agree not to:</p>
<ul style="color:var(--muted);margin-bottom:1rem;padding-left:1.5rem;line-height:2">
<li>Scrape, crawl, harvest, or systematically collect data or content from the Site without our prior written permission</li>
<li>Use automated tools, bots, or scripts to access the Site in a manner that could damage, disable, or impair its performance</li>
<li>Reproduce, republish, distribute, or commercially exploit any content from the Site without explicit written authorization</li>
<li>Attempt to gain unauthorized access to any portion of the Site or its related systems</li>
<li>Use the Site to transmit spam, malware, or any harmful or disruptive content</li>
<li>Misrepresent your identity or affiliation in connection with your use of the Site</li>
<li>Interfere with or disrupt the integrity or performance of the Site</li>
</ul>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">3. Intellectual Property Rights</h3>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">3.1 Our Original Content</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">All original content created and published by STREETWEAR.NEWS — including but not limited to original articles, editorial summaries, AI-generated article descriptions, site design, logos, graphics, and underlying code — is the exclusive intellectual property of STREETWEAR.NEWS and is protected by applicable copyright, trademark, and intellectual property laws.</p>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">3.2 Third-Party Content</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">The Site aggregates and displays headlines, summaries, images, and links sourced from third-party publications including but not limited to Hypebeast, Complex, Highsnobiety, Sneaker News, Sole Retriever, WWD, Modern Notoriety, and Just Fresh Kicks. All third-party content remains the exclusive intellectual property of its respective owners. STREETWEAR.NEWS does not claim ownership of any third-party content displayed on the Site.</p>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">3.3 Restricted Use</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">You may not copy, reproduce, modify, distribute, transmit, display, perform, publish, license, create derivative works from, or sell any content obtained from the Site without the prior written consent of the applicable rights holder.</p>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">4. Third-Party Content and External Links</h3>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">4.1 External Links</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">The Site contains links to third-party websites and publications. These links are provided solely for your convenience and informational purposes. STREETWEAR.NEWS does not endorse, control, or assume responsibility for the content, privacy practices, or accuracy of any third-party website. Clicking an external link is done entirely at your own risk.</p>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">4.2 Third-Party Websites</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">When you click a link to an external site, you leave streetwear.news and are subject to the terms and privacy policies of that third-party site. We encourage you to review those policies before providing any personal information on external sites.</p>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">4.3 No Endorsement</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">The inclusion of any link to a third-party website does not imply endorsement by STREETWEAR.NEWS of that website or any association with its operators.</p>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">5. Content Aggregation Disclaimer</h3>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">5.1 Nature of Aggregated Content</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">streetwear.news operates as a news aggregation platform. We collect, organize, and display publicly available headlines, article summaries, and thumbnail images from third-party publishers for the purpose of providing users with a centralized discovery experience. We link directly to the original source for all aggregated content.</p>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">5.2 Accuracy Disclaimer</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">STREETWEAR.NEWS does not independently verify the accuracy, completeness, or timeliness of aggregated third-party content. All aggregated content reflects the views and reporting of the original publisher, not STREETWEAR.NEWS. We are not responsible for errors, omissions, or inaccuracies in third-party content.</p>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">5.3 AI-Generated Summaries</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">Some article descriptions displayed on the Site are generated using artificial intelligence and are based solely on article titles and publicly available metadata. These summaries are provided for informational convenience only and may not fully represent the content of the original article. We recommend clicking through to the original source for complete and accurate information.</p>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">5.4 Content Removal Requests</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">If you are a publisher or rights holder and believe your content has been displayed in a manner that infringes your rights, please contact us at <a href="mailto:contact@streetwear.news" style="color:var(--accent)">contact@streetwear.news</a>. We will review and respond to legitimate removal requests promptly.</p>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">6. Advertising and Sponsored Content</h3>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">6.1 Display Advertising</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">The Site may display third-party advertisements served through advertising networks including but not limited to Google AdSense and other programmatic advertising partners. These advertisements are clearly distinguished from editorial content. STREETWEAR.NEWS is not responsible for the content of third-party advertisements or the products and services they promote.</p>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">6.2 Affiliate Links</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">The Site contains affiliate links to third-party retailers and marketplaces including but not limited to StockX, GOAT, Nike, Adidas, Foot Locker, Farfetch, and similar platforms. When you click an affiliate link and make a qualifying purchase, STREETWEAR.NEWS may earn a commission at no additional cost to you. Affiliate relationships do not influence our editorial coverage or the order in which content is displayed.</p>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">6.3 Sponsored Content</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">The Site may from time to time publish sponsored articles, brand partnerships, or paid editorial placements. All sponsored content will be clearly labeled as "Sponsored," "Paid Partnership," or similar designation in compliance with applicable FTC guidelines and advertising disclosure requirements.</p>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">6.4 FTC Disclosure Compliance</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">STREETWEAR.NEWS complies with the Federal Trade Commission's guidelines regarding endorsements and testimonials, including the disclosure of material connections between the Site and any brands, products, or services featured in sponsored or affiliate content.</p>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">7. Limitation of Liability</h3>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">To the fullest extent permitted by applicable law, STREETWEAR.NEWS, its operators, contributors, and affiliates shall not be liable for any indirect, incidental, special, consequential, or punitive damages arising out of or related to your use of or inability to use the Site, including but not limited to:</p>
<ul style="color:var(--muted);margin-bottom:1rem;padding-left:1.5rem;line-height:2">
<li>Loss of data or profits</li>
<li>Reliance on information published on the Site</li>
<li>Unauthorized access to or alteration of your data</li>
<li>Any errors, inaccuracies, or omissions in content</li>
<li>Any interruption or cessation of service</li>
</ul>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">This limitation applies regardless of the legal theory under which such damages are sought, even if STREETWEAR.NEWS has been advised of the possibility of such damages. In jurisdictions that do not allow the exclusion or limitation of incidental or consequential damages, our liability shall be limited to the maximum extent permitted by law.</p>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">8. Disclaimer of Warranties</h3>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">THE SITE AND ALL CONTENT, SERVICES, AND FEATURES ARE PROVIDED ON AN "AS IS" AND "AS AVAILABLE" BASIS WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED. STREETWEAR.NEWS EXPRESSLY DISCLAIMS ALL WARRANTIES INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.</p>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">We do not warrant that:</p>
<ul style="color:var(--muted);margin-bottom:1rem;padding-left:1.5rem;line-height:2">
<li>The Site will be uninterrupted, secure, or error-free</li>
<li>Any content on the Site is accurate, complete, or current</li>
<li>The Site or its servers are free of viruses or other harmful components</li>
<li>Any defects will be corrected</li>
</ul>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">Your use of the Site is entirely at your own risk.</p>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">9. DMCA / Copyright Policy</h3>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">9.1 Respect for Intellectual Property</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">STREETWEAR.NEWS respects the intellectual property rights of others and expects users and third parties to do the same.</p>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">9.2 DMCA Takedown Notices</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">If you believe that content appearing on the Site infringes your copyright, please submit a written notice to us at <a href="mailto:contact@streetwear.news" style="color:var(--accent)">contact@streetwear.news</a> containing the following information as required by the Digital Millennium Copyright Act (17 U.S.C. § 512):</p>
<ol style="color:var(--muted);margin-bottom:1rem;padding-left:1.5rem;line-height:2">
<li>A physical or electronic signature of the copyright owner or authorized agent</li>
<li>Identification of the copyrighted work claimed to have been infringed</li>
<li>Identification of the material on the Site that is claimed to be infringing, with sufficient detail to locate it</li>
<li>Your contact information including name, address, telephone number, and email address</li>
<li>A statement that you have a good faith belief that the use of the material is not authorized by the copyright owner, its agent, or the law</li>
<li>A statement made under penalty of perjury that the information in the notice is accurate and that you are the copyright owner or authorized to act on their behalf</li>
</ol>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">9.3 Response to Valid Notices</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">Upon receipt of a valid DMCA notice, we will investigate and, where appropriate, promptly remove or disable access to the allegedly infringing content.</p>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">9.4 Counter-Notices</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">If you believe content was removed in error, you may submit a counter-notice to <a href="mailto:contact@streetwear.news" style="color:var(--accent)">contact@streetwear.news</a> in accordance with 17 U.S.C. § 512(g).</p>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">10. Privacy</h3>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">Your use of the Site is also governed by our <a href="/privacy" style="color:var(--accent)">Privacy Policy</a>, which is incorporated into these Terms by reference. By using the Site, you consent to the data practices described in the Privacy Policy.</p>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">11. Modifications to the Terms</h3>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">STREETWEAR.NEWS reserves the right to modify these Terms at any time at our sole discretion. When changes are made, we will update the "Last Updated" date at the top of this page. Your continued use of the Site after any changes are posted constitutes your acceptance of the revised Terms.</p>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">12. Governing Law and Dispute Resolution</h3>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">These Terms shall be governed by and construed in accordance with the laws of the <strong style="color:var(--text)">State of California</strong>, without regard to its conflict of law provisions. Any disputes arising from or relating to these Terms or your use of the Site shall be subject to the exclusive jurisdiction of the state and federal courts located in <strong style="color:var(--text)">Los Angeles County, California</strong>. You consent to the personal jurisdiction of such courts and waive any objection to the laying of venue in Los Angeles County.</p>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">13. Severability</h3>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">If any provision of these Terms is found to be invalid, illegal, or unenforceable under applicable law, that provision shall be modified to the minimum extent necessary to make it enforceable, or if modification is not possible, severed from these Terms. The remaining provisions shall continue in full force and effect.</p>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">14. Entire Agreement</h3>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">These Terms, together with the Privacy Policy, constitute the entire agreement between you and STREETWEAR.NEWS regarding your use of the Site and supersede all prior agreements, representations, or understandings relating to the same subject matter.</p>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">15. Contact Information</h3>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">For questions, concerns, DMCA notices, or content removal requests, please contact us at:</p>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8"><strong style="color:var(--text)">STREETWEAR.NEWS</strong><br/>Los Angeles, California<br/>Email: <a href="mailto:contact@streetwear.news" style="color:var(--accent)">contact@streetwear.news</a></p>`
  );
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});


// ─── Privacy Policy ───────────────────────────────────────────────────────────
app.get('/privacy', (req, res) => {
  const html = renderStaticPage(
    'Privacy Policy',
    'Privacy policy for streetwear.news. Learn how we collect, use, and protect your data.',
    `<h2 style="font-family:Bebas Neue,sans-serif;font-size:2rem;letter-spacing:0.1em;color:var(--accent);margin-bottom:1.5rem">Privacy Policy</h2>
<p style="color:var(--muted);margin-bottom:0.25rem"><strong style="color:var(--text)">Effective Date:</strong> March 15, 2026</p>
<p style="color:var(--muted);margin-bottom:1rem"><strong style="color:var(--text)">Last Updated:</strong> March 15, 2026</p>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">STREETWEAR.NEWS ("we," "us," or "our") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, disclose, and safeguard information when you visit <strong style="color:var(--text)">streetwear.news</strong> (the "Site"). Please read this policy carefully. If you do not agree with its terms, please discontinue use of the Site.</p>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">1. Information We Collect</h3>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">1.1 Information You Provide</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">streetwear.news does not require you to create an account or submit personal information to browse the Site. If you contact us via email, we may collect your name and email address solely for the purpose of responding to your inquiry.</p>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">1.2 Information Collected Automatically</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">When you visit the Site, certain information may be collected automatically through your browser and device, including:</p>
<ul style="color:var(--muted);margin-bottom:1rem;padding-left:1.5rem;line-height:2">
<li><strong style="color:var(--text)">Log Data:</strong> IP address, browser type and version, operating system, referring URLs, pages visited, and the date and time of your visit</li>
<li><strong style="color:var(--text)">Device Information:</strong> Hardware model, operating system version, and unique device identifiers</li>
<li><strong style="color:var(--text)">Usage Data:</strong> Pages you view, links you click, time spent on pages, and navigation patterns within the Site</li>
<li><strong style="color:var(--text)">Location Data:</strong> General geographic location based on your IP address (country or city level only — we do not collect precise location data)</li>
</ul>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">1.3 Cookies and Similar Technologies</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">We and our third-party partners use cookies and similar tracking technologies to collect information about your browsing activity. See Section 3 for full details.</p>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">2. How We Use Information</h3>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">We use the information we collect for the following purposes:</p>
<ul style="color:var(--muted);margin-bottom:1rem;padding-left:1.5rem;line-height:2">
<li>To operate, maintain, and improve the Site and its features</li>
<li>To analyze traffic patterns and understand how users interact with the Site</li>
<li>To serve relevant advertisements through third-party ad networks</li>
<li>To detect, prevent, and address technical issues, fraud, or abuse</li>
<li>To respond to your inquiries or support requests</li>
<li>To comply with applicable legal obligations</li>
<li>To enforce our Terms &amp; Conditions</li>
</ul>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">We do not sell your personal information to third parties. We do not use your information to make automated decisions that produce legal or similarly significant effects on you.</p>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">3. Cookies and Tracking Technologies</h3>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">3.1 What Are Cookies</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">Cookies are small text files placed on your device when you visit a website. They are widely used to make websites work efficiently and to provide information to site operators. Some cookies are essential for the Site to function; others are used for analytics or advertising purposes.</p>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">3.2 Types of Cookies We Use</h4>
<ul style="color:var(--muted);margin-bottom:1rem;padding-left:1.5rem;line-height:2">
<li><strong style="color:var(--text)">Essential Cookies:</strong> Required for basic site functionality such as page load performance and security.</li>
<li><strong style="color:var(--text)">Analytics Cookies:</strong> Used by services like Google Analytics to collect anonymous data about how visitors use the Site, including pages visited and time on site. This data helps us improve the Site.</li>
<li><strong style="color:var(--text)">Advertising Cookies:</strong> Placed by third-party ad networks such as Google AdSense to deliver personalized advertisements based on your browsing behavior across websites.</li>
<li><strong style="color:var(--text)">Third-Party Cookies:</strong> Set by embedded content providers (such as social media platforms) when you interact with embedded posts or videos on the Site.</li>
</ul>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">3.3 Managing Cookies</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">You can control and manage cookies through your browser settings. Most browsers allow you to refuse cookies, delete existing cookies, or alert you when cookies are being set. Please note that disabling certain cookies may affect the functionality of the Site. For more information on managing cookies, visit <a href="https://www.allaboutcookies.org" target="_blank" rel="noopener" style="color:var(--accent)">allaboutcookies.org</a>.</p>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">To opt out of Google's use of cookies for advertising, visit <a href="https://adssettings.google.com" target="_blank" rel="noopener" style="color:var(--accent)">Google Ads Settings</a> or <a href="https://optout.networkadvertising.org" target="_blank" rel="noopener" style="color:var(--accent)">NAI Opt-Out</a>.</p>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">4. Third-Party Advertising</h3>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">4.1 Google AdSense</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">The Site may use Google AdSense, a third-party advertising service provided by Google LLC. Google AdSense uses cookies to serve ads based on your prior visits to this and other websites. Google's use of advertising cookies enables it and its partners to serve ads to you based on your visit to our Site and other sites on the internet.</p>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">You may opt out of personalized advertising by visiting <a href="https://adssettings.google.com" target="_blank" rel="noopener" style="color:var(--accent)">Google Ads Settings</a>. Alternatively, you can opt out of a third-party vendor's use of cookies for personalized advertising by visiting <a href="https://www.aboutads.info" target="_blank" rel="noopener" style="color:var(--accent)">www.aboutads.info</a>.</p>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">4.2 Other Ad Networks</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">We may work with additional programmatic advertising partners including but not limited to Raptive, Mediavine, or similar networks. These partners may use cookies and tracking technologies to deliver targeted advertisements. Each partner's data practices are governed by their own privacy policies.</p>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">4.3 Advertising Disclosure</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">All display advertisements are clearly distinguished from editorial content on the Site. We do not allow advertisers to influence our editorial coverage or content aggregation practices.</p>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">5. Analytics Services</h3>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">We may use Google Analytics, a web analytics service provided by Google LLC, to help us understand how users engage with the Site. Google Analytics collects information such as how often you visit the Site, what pages you view, and what other sites you visited prior to visiting ours. Google Analytics collects only the IP address assigned to you on the date you visit the Site, not your name or other personally identifying information.</p>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">We use the data collected by Google Analytics only to improve the Site. Google's ability to use and share information collected by Google Analytics about your visits is restricted by the <a href="https://marketingplatform.google.com/about/analytics/terms/us/" target="_blank" rel="noopener" style="color:var(--accent)">Google Analytics Terms of Service</a> and <a href="https://policies.google.com/privacy" target="_blank" rel="noopener" style="color:var(--accent)">Google Privacy Policy</a>.</p>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">You may opt out of Google Analytics tracking by installing the <a href="https://tools.google.com/dlpage/gaoptout" target="_blank" rel="noopener" style="color:var(--accent)">Google Analytics Opt-out Browser Add-on</a>.</p>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">6. Embedded Content from Other Websites</h3>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">The Site may include embedded content from third-party platforms such as Instagram, YouTube, Twitter/X, or other social media services. Embedded content from other websites behaves in the exact same way as if you visited those websites directly.</p>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">These third-party platforms may collect data about you, use cookies, embed additional third-party tracking, and monitor your interaction with the embedded content — including tracking your interaction if you have an account and are logged in to that platform. We have no control over the data practices of these third parties. We recommend reviewing the privacy policies of any third-party platform whose embedded content you interact with.</p>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">7. Affiliate Links and Sponsored Content</h3>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">7.1 Affiliate Links</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">The Site may contain affiliate links to third-party retailers and marketplaces including but not limited to StockX, GOAT, Nike, Adidas, Foot Locker, Farfetch, and similar platforms. When you click an affiliate link, the retailer may set cookies on your device to track the referral and any resulting purchase. STREETWEAR.NEWS may earn a commission on qualifying purchases at no additional cost to you.</p>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">Affiliate links are disclosed in accordance with FTC guidelines. The presence of affiliate links does not affect the editorial independence of content on the Site.</p>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">7.2 Sponsored Content</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">Any sponsored articles or paid partnerships published on the Site will be clearly labeled. Sponsored content may link to the sponsoring brand's website, which has its own privacy policy and data practices.</p>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">8. Data Sharing and Disclosure</h3>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">We do not sell, trade, or rent your personal information to third parties. We may share information in the following limited circumstances:</p>
<ul style="color:var(--muted);margin-bottom:1rem;padding-left:1.5rem;line-height:2">
<li><strong style="color:var(--text)">Service Providers:</strong> We may share data with trusted third-party service providers who assist in operating the Site (such as hosting providers, analytics services, and advertising networks), subject to confidentiality obligations.</li>
<li><strong style="color:var(--text)">Legal Requirements:</strong> We may disclose information if required to do so by law, court order, or governmental authority, or if we believe in good faith that such disclosure is necessary to protect our rights, your safety, or the safety of others.</li>
<li><strong style="color:var(--text)">Business Transfers:</strong> In the event of a merger, acquisition, or sale of assets, user data may be transferred as part of that transaction. We will notify users of any such change in ownership via a notice on the Site.</li>
</ul>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">9. Data Retention</h3>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">We retain automatically collected data (such as server logs and analytics data) for as long as necessary to fulfill the purposes outlined in this policy, typically no longer than 26 months, in line with Google Analytics data retention defaults. Data shared with us via email inquiries is retained only as long as necessary to respond to your request and for a reasonable period thereafter.</p>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">You may request deletion of any personal data we hold about you by contacting us at <a href="mailto:contact@streetwear.news" style="color:var(--accent)">contact@streetwear.news</a>.</p>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">10. Your Rights</h3>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">10.1 California Residents (CCPA)</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">If you are a California resident, you have the following rights under the California Consumer Privacy Act (CCPA):</p>
<ul style="color:var(--muted);margin-bottom:1rem;padding-left:1.5rem;line-height:2">
<li><strong style="color:var(--text)">Right to Know:</strong> You may request information about the categories and specific pieces of personal information we have collected about you.</li>
<li><strong style="color:var(--text)">Right to Delete:</strong> You may request deletion of personal information we have collected from you, subject to certain exceptions.</li>
<li><strong style="color:var(--text)">Right to Opt Out:</strong> You have the right to opt out of the sale of your personal information. We do not sell personal information.</li>
<li><strong style="color:var(--text)">Right to Non-Discrimination:</strong> We will not discriminate against you for exercising any of your CCPA rights.</li>
</ul>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">To exercise your CCPA rights, contact us at <a href="mailto:contact@streetwear.news" style="color:var(--accent)">contact@streetwear.news</a>.</p>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">10.2 European Users (GDPR)</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">If you are located in the European Economic Area (EEA), you have the following rights under the General Data Protection Regulation (GDPR):</p>
<ul style="color:var(--muted);margin-bottom:1rem;padding-left:1.5rem;line-height:2">
<li>The right to access personal data we hold about you</li>
<li>The right to rectification of inaccurate personal data</li>
<li>The right to erasure ("right to be forgotten")</li>
<li>The right to restrict processing of your personal data</li>
<li>The right to data portability</li>
<li>The right to object to processing based on legitimate interests</li>
<li>The right to withdraw consent at any time where processing is based on consent</li>
</ul>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">Our legal basis for processing data is legitimate interest in operating and improving the Site, and compliance with legal obligations. To exercise any GDPR rights, contact us at <a href="mailto:contact@streetwear.news" style="color:var(--accent)">contact@streetwear.news</a>. You also have the right to lodge a complaint with your local data protection authority.</p>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">10.3 All Users</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">Regardless of your location, you may contact us at any time to request access to, correction of, or deletion of personal data we hold about you. We will respond to all requests within a reasonable timeframe.</p>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">11. Children's Privacy</h3>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">The Site is not directed to children under the age of 13. We do not knowingly collect personal information from children under 13. If you are a parent or guardian and believe your child has provided us with personal information, please contact us at <a href="mailto:contact@streetwear.news" style="color:var(--accent)">contact@streetwear.news</a> and we will promptly delete such information. If we become aware that we have inadvertently collected personal information from a child under 13, we will take steps to delete it as soon as possible.</p>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">12. Security of Information</h3>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">We implement reasonable technical and organizational measures to protect the information we collect against unauthorized access, disclosure, alteration, or destruction. These measures include secure HTTPS transmission, access controls, and regular review of our data practices.</p>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">However, no method of transmission over the internet or electronic storage is 100% secure. While we strive to use commercially acceptable means to protect your information, we cannot guarantee absolute security. In the event of a data breach that affects your rights or freedoms, we will notify affected users and relevant authorities as required by applicable law.</p>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">13. Third-Party Privacy Policies</h3>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">This Privacy Policy applies only to streetwear.news. The Site contains links to and aggregates content from third-party websites whose privacy practices may differ from ours. We encourage you to review the privacy policies of any third-party sites you visit. Key third-party policies relevant to this Site include:</p>
<ul style="color:var(--muted);margin-bottom:1rem;padding-left:1.5rem;line-height:2">
<li><a href="https://policies.google.com/privacy" target="_blank" rel="noopener" style="color:var(--accent)">Google Privacy Policy</a> (AdSense, Analytics)</li>
<li><a href="https://help.instagram.com/519522125107875" target="_blank" rel="noopener" style="color:var(--accent)">Meta / Instagram Privacy Policy</a></li>
<li><a href="https://twitter.com/en/privacy" target="_blank" rel="noopener" style="color:var(--accent)">X (Twitter) Privacy Policy</a></li>
</ul>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">14. Changes to This Privacy Policy</h3>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">We reserve the right to update this Privacy Policy at any time. When we make changes, we will update the "Last Updated" date at the top of this page. Your continued use of the Site after any changes are posted constitutes your acceptance of the updated policy. We encourage you to review this page periodically to stay informed about how we protect your information.</p>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">15. Contact Information</h3>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">If you have questions, concerns, or requests regarding this Privacy Policy or your personal data, please contact us at:</p>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8"><strong style="color:var(--text)">STREETWEAR.NEWS</strong><br/>Los Angeles, California<br/>Email: <a href="mailto:contact@streetwear.news" style="color:var(--accent)">contact@streetwear.news</a></p>`
  );
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ─── Contact ──────────────────────────────────────────────────────────────────
app.get('/contact', (req, res) => {
  const html = renderStaticPage(
    'Contact Us',
    'Get in touch with the streetwear.news team for inquiries, partnerships, and content removal requests.',
    `<h2 style="font-family:Bebas Neue,sans-serif;font-size:2rem;letter-spacing:0.1em;color:var(--accent);margin-bottom:1.5rem">Contact Us</h2>

    <p style="color:var(--muted);margin-bottom:2rem">Have a question, partnership inquiry, or content removal request? Get in touch with us below.</p>

    <div style="display:grid;gap:1.5rem;margin-bottom:2rem">
      <div style="border:1px solid var(--border);padding:1.5rem">
        <h3 style="font-family:Bebas Neue,sans-serif;font-size:1.2rem;letter-spacing:0.05em;color:var(--text);margin-bottom:0.5rem">General Inquiries</h3>
        <p style="color:var(--muted)">For general questions about streetwear.news:</p>
        <a href="mailto:contact@streetwear.news" style="color:var(--accent);font-size:0.9rem">contact@streetwear.news</a>
      </div>
      <div style="border:1px solid var(--border);padding:1.5rem">
        <h3 style="font-family:Bebas Neue,sans-serif;font-size:1.2rem;letter-spacing:0.05em;color:var(--text);margin-bottom:0.5rem">Advertising &amp; Partnerships</h3>
        <p style="color:var(--muted)">For advertising opportunities and brand partnerships:</p>
        <a href="mailto:ads@streetwear.news" style="color:var(--accent);font-size:0.9rem">ads@streetwear.news</a>
      </div>
      <div style="border:1px solid var(--border);padding:1.5rem">
        <h3 style="font-family:Bebas Neue,sans-serif;font-size:1.2rem;letter-spacing:0.05em;color:var(--text);margin-bottom:0.5rem">Content Removal</h3>
        <p style="color:var(--muted)">If you are a publisher and would like your content removed from our aggregator:</p>
        <a href="mailto:contact@streetwear.news" style="color:var(--accent);font-size:0.9rem">contact@streetwear.news</a>
      </div>
    </div>

    <p style="color:var(--muted);font-size:0.85rem">We typically respond within 1-2 business days.</p>`
  );
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ─── Advertising ──────────────────────────────────────────────────────────────
app.get('/advertising', (req, res) => {
  const html = renderStaticPage(
    'Advertise on streetwear.news',
    'Reach a highly engaged streetwear and sneaker audience. Learn about advertising opportunities on streetwear.news.',
    `<h2 style="font-family:Bebas Neue,sans-serif;font-size:2rem;letter-spacing:0.1em;color:var(--accent);margin-bottom:1.5rem">Advertise on streetwear.news</h2>

    <p style="color:var(--muted);margin-bottom:2rem">streetwear.news reaches a highly engaged audience of streetwear enthusiasts, sneakerheads, and fashion-forward consumers who visit daily to stay on top of the latest drops, collabs, and culture.</p>

    <div style="display:grid;gap:1.5rem;margin-bottom:2rem">
      <div style="border:1px solid var(--border);padding:1.5rem">
        <h3 style="font-family:Bebas Neue,sans-serif;font-size:1.2rem;letter-spacing:0.05em;color:var(--text);margin-bottom:0.5rem">Our Audience</h3>
        <p style="color:var(--muted)">Streetwear enthusiasts and sneaker collectors who check the site daily for the latest news, drops, and collabs from brands like Nike, Adidas, Supreme, New Balance, and more.</p>
      </div>
      <div style="border:1px solid var(--border);padding:1.5rem">
        <h3 style="font-family:Bebas Neue,sans-serif;font-size:1.2rem;letter-spacing:0.05em;color:var(--text);margin-bottom:0.5rem">Advertising Opportunities</h3>
        <p style="color:var(--muted)">We offer display advertising, sponsored content, brand partnerships, and newsletter placements. All advertising is clearly labeled and non-intrusive.</p>
      </div>
      <div style="border:1px solid var(--border);padding:1.5rem">
        <h3 style="font-family:Bebas Neue,sans-serif;font-size:1.2rem;letter-spacing:0.05em;color:var(--text);margin-bottom:0.5rem">Get in Touch</h3>
        <p style="color:var(--muted);margin-bottom:0.5rem">To discuss advertising opportunities, media kit requests, or custom partnerships:</p>
        <a href="mailto:ads@streetwear.news" style="color:var(--accent);font-size:0.9rem">ads@streetwear.news</a>
      </div>
    </div>`
  );
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});


// ─── Accessibility Statement ──────────────────────────────────────────────────
app.get('/accessibility', (req, res) => {
  const html = renderStaticPage(
    'Accessibility Statement',
    'Our commitment to making streetwear.news accessible to all users, including those with disabilities.',
    `<h2 style="font-family:Bebas Neue,sans-serif;font-size:2rem;letter-spacing:0.1em;color:var(--accent);margin-bottom:1.5rem">Accessibility Statement</h2>
<p style="color:var(--muted);margin-bottom:0.25rem"><strong style="color:var(--text)">Last Updated:</strong> March 15, 2026</p>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8;margin-top:1rem">STREETWEAR.NEWS is committed to making our website accessible and usable for everyone, including people with disabilities. This Accessibility Statement explains our approach, the standards we work toward, the features we have in place, and where we know limitations currently exist.</p>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">1. Our Commitment to Accessibility</h3>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">We believe that access to news, culture, and information should not be limited by disability or circumstance. STREETWEAR.NEWS is designed to be as open and usable as possible for all visitors, regardless of the technology or assistive tools they use to browse the web.</p>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">We are actively working to improve the accessibility of this Site on an ongoing basis. Our goal is to meet or exceed the standards set out by the Web Content Accessibility Guidelines (WCAG) 2.1 at Level AA, which is the widely accepted benchmark for accessible web content.</p>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">2. Accessibility Standards</h3>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">We use the <strong style="color:var(--text)">Web Content Accessibility Guidelines (WCAG) 2.1, Level AA</strong> as our primary reference standard. These guidelines are developed by the World Wide Web Consortium (W3C) and are organized around four core principles — content must be:</p>
<ul style="color:var(--muted);margin-bottom:1rem;padding-left:1.5rem;line-height:2">
<li><strong style="color:var(--text)">Perceivable:</strong> Information and user interface components must be presentable to users in ways they can perceive, including via screen readers or other assistive technology.</li>
<li><strong style="color:var(--text)">Operable:</strong> User interface components and navigation must be operable, including full keyboard navigation without requiring a mouse.</li>
<li><strong style="color:var(--text)">Understandable:</strong> Information and the operation of the interface must be understandable, with clear language and predictable behavior.</li>
<li><strong style="color:var(--text)">Robust:</strong> Content must be robust enough to be interpreted reliably by a wide variety of user agents and assistive technologies.</li>
</ul>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">We also strive to align with relevant provisions of the Americans with Disabilities Act (ADA) and Section 508 of the Rehabilitation Act where applicable.</p>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">3. Accessibility Features of This Website</h3>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">We have implemented the following features to improve the accessibility of streetwear.news:</p>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">Structure and Navigation</h4>
<ul style="color:var(--muted);margin-bottom:1rem;padding-left:1.5rem;line-height:2">
<li>Semantic HTML elements are used throughout the Site, including proper heading hierarchy (H1, H2, H3) to aid screen reader navigation</li>
<li>The Site includes a visible page title and descriptive meta tags to assist users and assistive technologies in understanding page content</li>
<li>All interactive elements such as buttons and links are keyboard accessible</li>
<li>The Site uses a logical, consistent layout across all pages to support predictable navigation</li>
</ul>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">Visual Design</h4>
<ul style="color:var(--muted);margin-bottom:1rem;padding-left:1.5rem;line-height:2">
<li>The Site uses high-contrast color combinations to improve readability for users with low vision or color blindness</li>
<li>Text is rendered using relative units to support browser-level text scaling</li>
<li>The Site does not use flashing content or animations that could trigger photosensitive conditions, with the exception of minor UI transitions</li>
<li>Article card images include descriptive alt text attributes where available</li>
</ul>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">Content</h4>
<ul style="color:var(--muted);margin-bottom:1rem;padding-left:1.5rem;line-height:2">
<li>All external links open in a new tab and are labeled with context to help screen reader users understand their destination</li>
<li>Article summaries are displayed in plain text, avoiding excessive formatting that could interfere with assistive technology</li>
<li>The Site includes a skip-to-content mechanism via semantic landmark elements</li>
<li>Page language is declared as English in the HTML to assist screen readers in applying correct pronunciation</li>
</ul>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">Performance</h4>
<ul style="color:var(--muted);margin-bottom:1rem;padding-left:1.5rem;line-height:2">
<li>The Site is optimized for fast load times, including lazy loading of off-screen images, which benefits users on slower connections or assistive devices</li>
<li>Server-side rendering (SSR) ensures that core content is available in the HTML without requiring JavaScript, improving compatibility with certain assistive tools</li>
</ul>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">4. Known Limitations</h3>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">We are transparent about the areas where accessibility may currently be limited. We are actively working to address these over time:</p>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">Third-Party and Aggregated Content</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">streetwear.news aggregates headlines, images, and summaries from third-party publishers including Hypebeast, Complex, Highsnobiety, Sneaker News, Sole Retriever, WWD, Modern Notoriety, and Just Fresh Kicks. We do not control the accessibility of content on those external websites. When you follow a link to an original article, you are subject to that publisher's own accessibility practices.</p>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">Images and Alt Text</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">Article thumbnail images are sourced from third-party publishers. While we apply descriptive alt text using article titles where available, the quality and specificity of image descriptions may vary depending on the source. We are working to improve this over time.</p>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">Embedded Social Media Content</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">The Site may display embedded content from platforms such as Instagram, YouTube, or Twitter/X. These embeds are served directly by third-party platforms and may not fully conform to WCAG 2.1 Level AA standards. We do not have direct control over the accessibility of embedded third-party content.</p>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">Third-Party Advertising</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">The Site may display advertisements served through third-party networks such as Google AdSense. We do not control the accessibility of ad creatives delivered by these networks. If you encounter an advertisement that creates an accessibility barrier, please contact us and we will investigate.</p>
<h4 style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;letter-spacing:0.05em;color:var(--text);margin:1rem 0 0.4rem">Older Browser Compatibility</h4>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">While the Site is designed to work across modern browsers, some accessibility features may not function as intended in significantly outdated browser versions. We recommend using an up-to-date browser for the best experience.</p>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">5. Ongoing Improvements</h3>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">Accessibility is not a one-time fix — it is an ongoing commitment. We regularly review the Site against WCAG 2.1 guidelines and incorporate improvements as the Site evolves. Our current and planned accessibility improvements include:</p>
<ul style="color:var(--muted);margin-bottom:1rem;padding-left:1.5rem;line-height:2">
<li>Improving color contrast ratios across muted text elements to better meet WCAG AA thresholds</li>
<li>Adding a visible focus indicator for keyboard navigation throughout the Site</li>
<li>Enhancing mobile accessibility including touch target sizing and gesture navigation</li>
<li>Introducing a cookie consent and preference manager to give users greater control over tracking and advertising cookies</li>
<li>Improving screen reader compatibility for the source filter dropdown and search functionality</li>
</ul>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">We welcome feedback from users who encounter accessibility barriers — your input directly informs our improvement priorities.</p>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">6. Assistive Technology Compatibility</h3>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">streetwear.news is designed to be compatible with the following assistive technologies:</p>
<ul style="color:var(--muted);margin-bottom:1rem;padding-left:1.5rem;line-height:2">
<li><strong style="color:var(--text)">Screen Readers:</strong> Including NVDA, JAWS, VoiceOver (macOS/iOS), and TalkBack (Android)</li>
<li><strong style="color:var(--text)">Keyboard Navigation:</strong> All core functions can be accessed using a keyboard alone</li>
<li><strong style="color:var(--text)">Browser Zoom:</strong> The Site supports up to 200% zoom without loss of content or functionality</li>
<li><strong style="color:var(--text)">High Contrast Mode:</strong> The Site's dark color scheme is compatible with operating system high-contrast settings</li>
</ul>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">7. Feedback and Assistance</h3>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">We genuinely want to hear from you if you experience any accessibility barriers on streetwear.news. Your feedback helps us identify issues we may have missed and prioritize improvements that make the biggest difference for real users.</p>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">If you are having difficulty accessing any content or feature on the Site, please contact us and we will:</p>
<ul style="color:var(--muted);margin-bottom:1rem;padding-left:1.5rem;line-height:2">
<li>Acknowledge your message within 2 business days</li>
<li>Investigate the accessibility issue you have reported</li>
<li>Provide an accessible alternative format for the content where possible</li>
<li>Work to resolve the underlying issue in a future update</li>
</ul>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">We are committed to responding to accessibility feedback in a timely and constructive manner.</p>
<hr style="border:none;border-top:1px solid var(--border);margin:2rem 0"/>

<h3 style="font-family:Bebas Neue,sans-serif;font-size:1.3rem;letter-spacing:0.05em;color:var(--text);margin:1.5rem 0 0.5rem">8. Contact Information</h3>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">To report an accessibility issue, request content in an alternative format, or ask questions about our accessibility practices, please contact us at:</p>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8"><strong style="color:var(--text)">STREETWEAR.NEWS</strong><br/>Los Angeles, California<br/>Email: <a href="mailto:contact@streetwear.news" style="color:var(--accent)">contact@streetwear.news</a></p>
<p style="color:var(--muted);margin-bottom:1rem;line-height:1.8">Please include as much detail as possible about the accessibility barrier you encountered, including the page URL, the assistive technology you are using, and a description of the issue. This helps us investigate and resolve the problem as quickly as possible.</p>`
  );
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.get('/weekly/:slug', async (req, res) => {
  const slug = req.params.slug;
  // Validate slug format YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(slug)) return res.status(404).send('Not found');

  if (cachedArticles.length === 0 && fetchInProgress) await fetchInProgress;

  const articles = getWeeklyArticles(slug);
  const weekLabel = getWeekLabel(slug);
  const indexPath = path.join(__dirname, 'public', 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');

  // Update title and meta
  html = html.replace(
    '<title>Streetwear News, Sneaker Drops &amp; Collabs | streetwear.news</title>',
    '<title>Streetwear News: Week of ' + weekLabel + ' | streetwear.news</title>'
  );

  // Inject weekly schema
  const weekSchema = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    'name': 'Streetwear News: Week of ' + weekLabel,
    'description': 'The best streetwear news, sneaker drops, and collab releases for the week of ' + weekLabel + '.',
    'url': 'https://streetwear.news/weekly/' + slug
  };
  html = html.slice(0, html.indexOf('</head>')) +
    '<script type="application/ld+json">' + JSON.stringify(weekSchema) + '</' + 'script>' +
    html.slice(html.indexOf('</head>'));

  // Build SSR cards
  const ssrCards = articles.slice(0, 30).map(a => {
    const t = (a.title||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const d = (a.description||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const l = (a.link||'').replace(/"/g,'&quot;');
    const s = (a.sourceName||'').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const c = (a.source||'').toLowerCase();
    const img = a.image ? '<img class="card-img" src="' + a.image.replace(/"/g,'&quot;') + '" alt="' + t + '" loading="lazy">' : '<div class="card-img-placeholder">' + s + '</div>';
    return '<div class="card"><div class="card-meta"><span class="source-tag ' + c + '">' + s + '</span></div>' + img + '<div class="card-title">' + t + '</div>' + (d ? '<div class="card-desc">' + d + '</div>' : '') + '<a class="card-link" href="' + l + '" target="_blank" rel="noopener">Read Full Article &#8594;</a></div>';
  }).join('');

  const startMarker = '<!-- SSR_GRID_START -->';
  const endMarker = '<!-- SSR_GRID_END -->';
  const startIdx = html.indexOf(startMarker);
  const endIdx = html.indexOf(endMarker);
  if (startIdx !== -1 && endIdx !== -1) {
    const heading = '<h2 style="padding:1.5rem 2rem 0.5rem;font-family:Bebas Neue,sans-serif;font-size:1.8rem;letter-spacing:0.1em;color:var(--text)">Week of ' + weekLabel + ' &mdash; Streetwear News Digest</h2>';
    html = html.slice(0, startIdx) + heading + startMarker + '<div class="grid" id="grid">' + ssrCards + '</div>' + html.slice(endIdx + endMarker.length);
  }

  // Inject JSON for client
  const scriptTag = '<script>window.__SSR_ARTICLES__=' + JSON.stringify(articles) + ';window.__SSR_WEEKLY__="' + slug + '";</' + 'script>';
  const headClose = html.indexOf('</head>');
  if (headClose !== -1) html = html.slice(0, headClose) + scriptTag + html.slice(headClose);

  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.get('*', async (req, res) => {
  try {
    // Never block response waiting for feeds — serve immediately with whatever is cached
    // This prevents AdsBot-Google and other crawlers from timing out
    const indexPath = path.join(__dirname, 'public', 'index.html');
    let html = fs.readFileSync(indexPath, 'utf8');
    // If cache is empty (cold start), wait up to 8 seconds for first fetch to populate
    if (cachedArticles.length === 0 && fetchInProgress) {
      console.log('Cold start: waiting briefly for feeds...');
      await Promise.race([
        fetchInProgress,
        new Promise(r => setTimeout(r, 8000))
      ]);
    }

    if (cachedArticles.length > 0) {
      const ssrArticles = cachedArticles.slice(0, 15);

      // Step 1: Inject grid cards using markers
      const staticCards = ssrArticles.map(a => {
        const t = (a.title||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        const d = (a.description||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        const l = (a.link||'').replace(/"/g,'&quot;');
        const s = (a.sourceName||'').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        const c = (a.source||'').toLowerCase();
        const imgIdx = ssrArticles.indexOf(a);
        const imgPriority = imgIdx < 5 ? 'high' : 'low';
        const imgLoading = imgIdx < 5 ? 'eager' : 'lazy';
        const img = a.image ? '<img class="card-img" src="' + a.image.replace(/"/g,'&quot;') + '" alt="' + t + '" loading="' + imgLoading + '" fetchpriority="' + imgPriority + '">' : '<div class="card-img-placeholder">' + s + '</div>';
        return '<div class="card"><div class="card-meta"><span class="source-tag ' + c + '">' + s + '</span></div>' + img + '<div class="card-title">' + t + '</div>' + (d ? '<div class="card-desc">' + d + '</div>' : '') + '<a class="card-link" href="' + l + '" target="_blank" rel="noopener">Read Full Article &#8594;</a></div>';
      }).join('');
      const startMarker = '<!-- SSR_GRID_START -->';
      const endMarker = '<!-- SSR_GRID_END -->';
      const startIdx = html.indexOf(startMarker);
      const endIdx = html.indexOf(endMarker);
      if (startIdx !== -1 && endIdx !== -1) {
        const gridTag = '<div class="grid" id="grid">';
        html = html.slice(0, startIdx) + startMarker + gridTag + staticCards + '</div>' + html.slice(endIdx + endMarker.length);
        console.log('SSR grid done, length=' + html.length);
      }

      // Step 2: Inject JSON into head using index splice — avoids String.replace() dollar-sign bug
      const jsonData = JSON.stringify(ssrArticles);
      const scriptTag = '<script>window.__SSR_ARTICLES__=' + jsonData + ';</' + 'script>';
      const headCloseIdx = html.indexOf('</head>');
      if (headCloseIdx !== -1) {
        html = html.slice(0, headCloseIdx) + scriptTag + html.slice(headCloseIdx);
        console.log('SSR head done, length=' + html.length);
      }

      // Step 3: Inject NewsArticle schema for SSR articles
      const newsSchema = {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        'name': 'Latest Streetwear News',
        'itemListElement': ssrArticles.map((a, i) => ({
          '@type': 'ListItem',
          'position': i + 1,
          'item': {
            '@type': 'NewsArticle',
            'headline': a.title,
            'url': a.link,
            'image': a.image || '',
            'datePublished': a.date,
            'publisher': {
              '@type': 'Organization',
              'name': a.sourceName
            }
          }
        }))
      };
      const schemaTag = '<script type="application/ld+json">' + JSON.stringify(newsSchema) + '</' + 'script>';
      const bodyIdx = html.indexOf('<body>');
      if (bodyIdx !== -1) {
        html = html.slice(0, bodyIdx + 6) + schemaTag + html.slice(bodyIdx + 6);
      }
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
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
  // Pre-fetch drops 15 seconds after boot (gives server time to fully start)
  setTimeout(() => {
    console.log('Pre-fetching drops cache...');
    refreshDropsInBackground();
  }, 15000);
  // Pre-fetch videos 20 seconds after boot
  setTimeout(() => {
    console.log('Pre-fetching videos...');
    fetchAllVideos();
  }, 20000);
  // Background refresh every 10 minutes — keeps article cache warm
  setInterval(() => fetchAllFeeds().catch(console.error), 10 * 60 * 1000);
  // Auto-refresh drops every hour in background — no visitor ever waits
  setInterval(() => refreshDropsInBackground(), 60 * 60 * 1000);
  // Auto-refresh videos every 30 minutes
  setInterval(() => fetchAllVideos(), 30 * 60 * 1000);
});






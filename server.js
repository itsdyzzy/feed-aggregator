const express = require('express');
const Parser = require('rss-parser');
const fetch = require('node-fetch');
const path = require('path');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;
const parser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  customFields: {
    item: [['media:content', 'mediaContent'], ['media:thumbnail', 'mediaThumbnail'], ['enclosure', 'enclosure']]
  }
});

// Cache
let cachedArticles = [];
let lastFetch = 0;
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function extractImage(item) {
  // media:content
  if (item.mediaContent?.$.url?.startsWith('http')) return item.mediaContent.$.url;
  // media:thumbnail
  if (item.mediaThumbnail?.$.url?.startsWith('http')) return item.mediaThumbnail.$.url;
  // enclosure
  if (item.enclosure?.url?.startsWith('http')) return item.enclosure.url;
  // Search content for img tags
  const content = item['content:encoded'] || item.content || item.description || '';
  const imgMatch = content.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch?.[1]?.startsWith('http')) return imgMatch[1];
  // Direct image URL in content
  const urlMatch = content.match(/https?:\/\/[^\s"'<>]+\.(?:jpg|jpeg|png|webp)(?:[?][^\s"'<>]*)?/i);
  if (urlMatch) return urlMatch[0];
  return null;
}

async function fetchOgImage(url) {
  try {
    const res = await fetch(url, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const html = await res.text();
    const match = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    return match?.[1]?.startsWith('http') ? match[1] : null;
  } catch { return null; }
}

// ─── HYPEBEAST ────────────────────────────────────────────────────────────────

async function fetchHypebeast() {
  try {
    const res = await fetch('https://hypebeast.com/feed', {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const xml = await res.text();
    const feed = await parser.parseString(xml);
    return feed.items.slice(0, 20).map(item => {
      let image = extractImage(item);
      // Hypebeast stores image in content:encoded
      if (!image) {
        const content = item['content:encoded'] || '';
        const m = content.match(/https?:\/\/image-cdn\.hypb\.st[^\s"'<>]+/i);
        if (m) image = m[0];
      }
      return {
        source: 'hypebeast',
        sourceName: 'Hypebeast',
        title: item.title || '',
        description: '',
        link: item.link || '',
        date: item.pubDate || item.isoDate || '',
        image
      };
    });
  } catch (e) {
    console.error('Hypebeast error:', e.message);
    return [];
  }
}

// ─── HIGHSNOBIETY ─────────────────────────────────────────────────────────────

async function fetchHighsnobiety() {
  try {
    const feed = await parser.parseURL('https://www.highsnobiety.com/feed/');
    const articles = [];
    for (const item of feed.items.slice(0, 20)) {
      let image = extractImage(item);
      // Highsnobiety strips images from RSS - fetch og:image from article
      if (!image && item.link) {
        image = await fetchOgImage(item.link);
      }
      articles.push({
        source: 'highsnobiety',
        sourceName: 'Highsnobiety',
        title: item.title || '',
        description: item.contentSnippet || '',
        link: item.link || '',
        date: item.pubDate || item.isoDate || '',
        image
      });
    }
    return articles;
  } catch (e) {
    console.error('Highsnobiety error:', e.message);
    return [];
  }
}

// ─── COMPLEX (PLAYWRIGHT) ─────────────────────────────────────────────────────

async function fetchComplex() {
  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const articles = [];
    const seen = new Set();

    for (const url of ['https://www.complex.com/sneakers', 'https://www.complex.com/style']) {
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

        // Wait for Latest Stories to load
        await page.waitForTimeout(3000);

        // Scroll to trigger lazy loading
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
        await page.waitForTimeout(2000);

        // Extract Latest Stories articles
        const pageArticles = await page.evaluate(() => {
          const results = [];

          // Remove hero and highlights sections
          document.querySelectorAll('div').forEach(div => {
            if (div.className?.includes('md:-order-1')) div.remove();
          });
          document.querySelectorAll('div.grid-container').forEach(div => {
            if (div.textContent?.includes('Highlights')) div.remove();
          });

          // Find all article links
          const links = [...document.querySelectorAll('a[href*="/a/"]')];
          for (const a of links) {
            const href = a.getAttribute('href');
            if (!href || href.startsWith('http') || href.includes('/sports/') || href.includes('/v/')) continue;

            // Get title
            const titleEl = a.querySelector('h1,h2,h3,h4,p') || a;
            let title = titleEl.textContent?.trim() || '';
            title = title.replace(/^(Sneakers|Style|Pop Culture|Music|Sports|Life|Rides|Tech)+/i, '').trim();
            if (!title || title.length < 10) continue;

            // Get image - walk up DOM to find nearby img
            let imgSrc = null;
            let el = a;
            for (let i = 0; i < 6; i++) {
              const img = el.querySelector('img');
              if (img?.src?.startsWith('http')) { imgSrc = img.src; break; }
              el = el.parentElement;
              if (!el) break;
            }

            // Upgrade image quality
            if (imgSrc) {
              imgSrc = imgSrc.replace(/\/upload\/[^/]+\//, '/upload/q_auto,f_jpg,w_800,c_fill,ar_1.78,g_center/');
            }

            results.push({
              href: 'https://www.complex.com' + href,
              title,
              image: imgSrc
            });
          }
          return results;
        });

        for (const a of pageArticles) {
          if (seen.has(a.title)) continue;
          seen.add(a.title);
          articles.push({
            source: 'complex',
            sourceName: 'Complex',
            title: a.title,
            description: '',
            link: a.href,
            date: new Date().toISOString(),
            image: a.image
          });
        }
      } catch (e) {
        console.error(`Complex page error (${url}):`, e.message);
      } finally {
        await page.close();
      }
    }

    return articles.slice(0, 20);
  } catch (e) {
    console.error('Complex Playwright error:', e.message);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

// ─── MAIN FETCH ───────────────────────────────────────────────────────────────

async function fetchAllFeeds() {
  console.log('Fetching all feeds...');
  try {
    const [hypebeast, highsnobiety, complex] = await Promise.allSettled([
      fetchHypebeast(),
      fetchHighsnobiety(),
      fetchComplex()
    ]);

    const articles = [
      ...(hypebeast.status === 'fulfilled' ? hypebeast.value : []),
      ...(highsnobiety.status === 'fulfilled' ? highsnobiety.value : []),
      ...(complex.status === 'fulfilled' ? complex.value : [])
    ];

    // Sort by date, newest first
    articles.sort((a, b) => new Date(b.date) - new Date(a.date));

    cachedArticles = articles;
    lastFetch = Date.now();
    console.log(`Fetched ${articles.length} articles total`);
    return articles;
  } catch (e) {
    console.error('fetchAllFeeds error:', e);
    return cachedArticles;
  }
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/articles', async (req, res) => {
  try {
    const now = Date.now();
    if (cachedArticles.length === 0 || now - lastFetch > CACHE_TTL) {
      await fetchAllFeeds();
    }
    res.json({ articles: cachedArticles, lastFetch });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/refresh', async (req, res) => {
  lastFetch = 0; // Force refresh
  await fetchAllFeeds();
  res.json({ articles: cachedArticles, lastFetch });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── START ────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`Feed aggregator running on port ${PORT}`);
  // Pre-fetch on startup
  fetchAllFeeds().catch(console.error);
});

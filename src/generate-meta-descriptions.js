#!/usr/bin/env node
/**
 * generate-meta-descriptions.js: bulk meta description writer for a Shopify store
 *
 * Scans products, collections, blog articles and pages, and writes meta
 * descriptions (140 to 160 characters) through the Admin API metafields.
 *
 * Quality rules:
 *   Missing (null/empty)   generate
 *   Too short (< 140)      rewrite
 *   Too long  (> 160)      rewrite to fit
 *   Good length (140-160)  skip (existing copy is preserved)
 *
 * Each description is built from a template chosen by page type and search
 * intent. Pages listed in the keyword map get their target keyword up front;
 * everything else falls back to a title-based template. Keyword map, brand
 * and all template wording live in config/meta.json.
 *
 * Usage:
 *   node src/generate-meta-descriptions.js --audit        preview all changes, no writes
 *   node src/generate-meta-descriptions.js --products     products only
 *   node src/generate-meta-descriptions.js --collections  collections only
 *   node src/generate-meta-descriptions.js --blogs        blog articles only
 *   node src/generate-meta-descriptions.js --pages        static pages only
 *   node src/generate-meta-descriptions.js                run everything
 */

require('dotenv').config({ quiet: true });
const fs   = require('fs');
const path = require('path');
const axios = require('axios');

// ─── Config ────────────────────────────────────────────────────────────────
const STORE       = process.env.SHOPIFY_STORE || '';
const TOKEN       = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = '2024-01';
const BASE_API    = `https://${STORE}/admin/api/${API_VERSION}`;

// Meta description target range
const META_MIN = 140;
const META_MAX = 160;

const AUDIT            = process.argv.includes('--audit') || process.argv.includes('--dry-run');
const PRODUCTS_ONLY    = process.argv.includes('--products');
const COLLECTIONS_ONLY = process.argv.includes('--collections');
const BLOGS_ONLY       = process.argv.includes('--blogs');
const PAGES_ONLY       = process.argv.includes('--pages');
const CONFIG_DIR       = process.env.CONFIG_DIR || path.resolve(__dirname, '..', 'config');
const STATE_DIR        = process.env.STATE_DIR  || path.resolve(__dirname, '..', 'state');
const STATE_FILE       = path.join(STATE_DIR, 'meta-desc-state.json');

// ─── Profile: config/meta.json (falls back to the example) ──────────────────
//   brand            shown in every description
//   keywordMap       URL path to { keyword, intent, traffic }; intent is
//                    transactional, commercial or informational
//   typeDescriptors  product type or title phrase to a short descriptor
//   qualityModifiers regex fragment to label, picked up from product titles
//   phrases          the closing sentences of each template
//   pages            title keyword to a full description for static pages
function loadConfig() {
  for (const f of ['meta.json', 'meta.example.json']) {
    const p = path.join(CONFIG_DIR, f);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  throw new Error('Missing config/meta.json');
}
const CONFIG = loadConfig();
const BRAND  = process.env.COMPANY_NAME || CONFIG.brand || 'Our Store';
const URL_KEYWORD_MAP  = CONFIG.keywordMap || {};
const TYPE_DESCRIPTORS = CONFIG.typeDescriptors || {};
const QUALITY_MODIFIERS = (CONFIG.qualityModifiers || []).map(m => ({ re: new RegExp(`\\b(?:${m.pattern})\\b`, 'i'), label: m.label }));
const PHRASES = CONFIG.phrases || {};
const PAGE_TEMPLATES = CONFIG.pages || {};
const fill = s => String(s || '').replace(/\{brand\}/g, BRAND);
// "at {brand}." without doubling the period when the brand name ends in one
const BRAND_STOP = BRAND.endsWith('.') ? BRAND : `${BRAND}.`;
// Shorten a title to n characters on a word boundary, only when it is longer
const clip = (t, n) => (t.length <= n ? t : t.substring(0, n).replace(/\s\S*$/, ''));

function getKeywordForUrl(urlPath) {
  if (URL_KEYWORD_MAP[urlPath]) return URL_KEYWORD_MAP[urlPath];
  const clean = urlPath.replace(/\/$/, '').split('?')[0];
  return URL_KEYWORD_MAP[clean] || null;
}

// ─── Product descriptor engine ───────────────────────────────────────────────
// Longest matching key wins, so "cold brew concentrate" beats "concentrate".
function getTypeDescriptor(title, type) {
  const combined = `${title} ${type}`.toLowerCase();
  const sorted   = Object.keys(TYPE_DESCRIPTORS).sort((a, b) => b.length - a.length);
  for (const key of sorted) {
    if (combined.includes(key)) return TYPE_DESCRIPTORS[key];
  }
  return null;
}

function extractQualityModifiers(title) {
  return QUALITY_MODIFIERS.filter(m => m.re.test(title)).map(m => m.label);
}

// ─── Meta description generators ─────────────────────────────────────────────

// Fit a string into the 140 to 160 character range.
// In range: returned as is. Too long: cut at the last sentence end inside the
// range, else at the last comma, else at the last whole word. Too short:
// returned as is, and the audit reports it as outside the target.
function fitMeta(str) {
  str = str.replace(/\s+/g, ' ').trim();

  if (str.length >= META_MIN && str.length <= META_MAX) return str;

  if (str.length > META_MAX) {
    const chunk = str.substring(0, META_MAX);
    const sentEnd = chunk.match(/^(.*[.!?])\s/);
    if (sentEnd && sentEnd[1].length >= META_MIN) return sentEnd[1].trim();
    const comma = chunk.lastIndexOf(',');
    if (comma >= META_MIN) return chunk.substring(0, comma).trim() + '.';
    return chunk.replace(/\s\S*$/, '').trim();
  }

  return str;
}

/**
 * PRODUCT page.
 *   Transactional keyword:  "Buy {keyword} online at {brand}: {descriptor}. {closing}"
 *   Commercial keyword:     "Shop {keyword} at {brand}: {descriptor}. {closing}"
 *   No keyword:             "Shop {title} at {brand}: {descriptor}. {closing}"
 */
function metaForProduct(product, kwData) {
  const title    = (product.title || '').trim();
  const type     = (product.product_type || '').trim().toLowerCase();
  const desc     = getTypeDescriptor(title, type) || type || PHRASES.defaultDescriptor || 'product';
  const mods     = extractQualityModifiers(title).slice(0, 2);
  const modStr   = mods.length ? mods.join(', ') + ' ' : '';
  const richDesc = `${modStr}${desc}`;

  if (kwData) {
    const kw = kwData.keyword;
    if (kwData.intent === 'transactional') {
      return fitMeta(`Buy ${kw} online at ${BRAND}: ${richDesc}. ${fill(PHRASES.productTransactional)}`);
    }
    return fitMeta(`Shop ${kw} at ${BRAND}: ${richDesc}. ${fill(PHRASES.productCommercial)}`);
  }

  // No keyword data: use the product title
  if (/wholesale/i.test(title)) {
    return fitMeta(`${title} at ${BRAND}: ${richDesc}. ${fill(PHRASES.productWholesale)}`);
  }
  return fitMeta(`Shop ${title} at ${BRAND}: ${richDesc}. ${fill(PHRASES.productDefault)}`);
}

/**
 * COLLECTION page.
 *   "Shop {keyword} at {brand}. {closing}" or "Browse {keyword} at {brand}. {closing}"
 */
function metaForCollection(collection, kwData) {
  const title       = (collection.title || '').replace(/\s[---|].*$/, '').trim();
  const isWholesale = /wholesale/i.test(collection.title || '');
  const wholesale   = isWholesale ? ` ${fill(PHRASES.collectionWholesaleNote)}` : '';

  if (kwData) {
    const kw = kwData.keyword;
    if (kwData.intent === 'transactional') {
      return fitMeta(`Shop ${kw} at ${BRAND_STOP} ${fill(PHRASES.collectionTransactional)}`);
    }
    return fitMeta(`Browse ${kw} at ${BRAND_STOP} ${fill(PHRASES.collectionCommercial)}${wholesale}`);
  }

  return fitMeta(`Browse ${title} at ${BRAND_STOP} ${fill(PHRASES.collectionDefault)}${wholesale}`);
}

/**
 * BLOG ARTICLE.
 *   Informational keyword:  "Learn about {keyword} with {brand}'s guide. {title}: {closing}"
 *   Commercial keyword:     "Find the best {keyword}: {closing}"
 *   No keyword:             "{title}. {closing}"
 */
function metaForArticle(article, kwData) {
  const title = (article.title || '').trim();

  if (kwData) {
    const kw = kwData.keyword;
    if (kwData.intent === 'informational') {
      return fitMeta(
        `Learn about ${kw} with ${BRAND}'s guide. ` +
        `${clip(title, 80)}: ${fill(PHRASES.articleInformational)}`
      );
    }
    return fitMeta(`Find the best ${kw}: ${fill(PHRASES.articleCommercial)}`);
  }

  return fitMeta(`${clip(title, 100)}. ${fill(PHRASES.articleDefault)}`);
}

/**
 * Static PAGE (FAQ, about, contact and so on): a full description per title
 * keyword from config, else a generic one.
 */
function metaForPage(page) {
  const title = (page.title || '').trim();
  const titleLower = title.toLowerCase();
  for (const [key, tmpl] of Object.entries(PAGE_TEMPLATES)) {
    if (titleLower.includes(key)) return fitMeta(fill(tmpl));
  }
  return fitMeta(`${title}: ${fill(PHRASES.pageDefault)}`);
}

// ─── Meta description quality check ──────────────────────────────────────────
function metaStatus(existing) {
  if (!existing || !existing.trim()) return 'missing';
  const len = existing.trim().length;
  if (len < META_MIN) return 'too_short';
  if (len > META_MAX) return 'too_long';
  return 'ok';
}

// ─── Shopify helpers ──────────────────────────────────────────────────────────
const shopify = axios.create({
  baseURL: BASE_API,
  headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
  validateStatus: () => true,
  timeout: 30000,
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { done: {}, counts: { missing: 0, too_short: 0, too_long: 0, ok: 0, updated: 0 } }; }
}
function saveState(s) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

async function fetchAll(endpoint, key) {
  const results = [];
  let url = `${endpoint}?limit=250`;
  while (url) {
    await sleep(500);
    const resp = await shopify.get(url.replace(BASE_API, ''));
    if (resp.data[key]) results.push(...resp.data[key]);
    const next = (resp.headers?.link || '').match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
  return results;
}

// Fetch current meta description for any resource
async function fetchMetaDescription(ownerResource, ownerId) {
  await sleep(300);
  const resp = await shopify.get(
    `/${ownerResource}/${ownerId}/metafields.json?namespace=global&key=description_tag`
  );
  const fields = resp.data?.metafields || [];
  const field  = fields.find(f => f.namespace === 'global' && f.key === 'description_tag');
  return field ? { value: field.value, id: field.id } : null;
}

// Create or update meta description metafield
async function writeMetaDescription(ownerResource, ownerId, value, existingId) {
  await sleep(600);
  if (existingId) {
    // Update existing metafield
    const resp = await shopify.put(
      `/${ownerResource}/${ownerId}/metafields/${existingId}.json`,
      { metafield: { id: existingId, value, type: 'single_line_text_field' } }
    );
    return resp.data?.metafield;
  } else {
    // Create new metafield
    const resp = await shopify.post(
      `/${ownerResource}/${ownerId}/metafields.json`,
      { metafield: { namespace: 'global', key: 'description_tag', value, type: 'single_line_text_field' } }
    );
    return resp.data?.metafield;
  }
}

// ─── Pipeline runners ─────────────────────────────────────────────────────────

async function processProducts(state) {
  console.log('\n📦 Products...');
  const products = await fetchAll('/products.json', 'products');
  console.log(`   Found ${products.length} products`);

  let updated = 0;
  const previews = [];

  for (const product of products) {
    // Skip draft and archived products: only active products get meta descriptions
    if (product.status && product.status !== 'active') continue;

    const key     = `product-${product.id}`;
    if (state.done[key] === 'ok') continue;

    const urlPath = `/products/${product.handle}`;
    const kwData  = getKeywordForUrl(urlPath);

    const existing = await fetchMetaDescription('products', product.id);
    const current  = existing?.value || null;
    const status   = metaStatus(current);

    if (status === 'ok') {
      state.done[key] = 'ok';
      state.counts.ok++;
      continue;
    }

    const newMeta = metaForProduct(product, kwData);

    if (AUDIT) {
      previews.push({
        type: 'product', url: urlPath,
        keyword: kwData?.keyword || '(template)',
        status, current: current ? current.substring(0, 80) + '…' : '(none)',
        new_meta: newMeta, length: newMeta.length,
      });
      state.counts[status]++;
      continue;
    }

    try {
      const result = await writeMetaDescription('products', product.id, newMeta, existing?.id);
      if (result) {
        const action = status === 'missing' ? '✅' : '✏️ ';
        console.log(`  ${action} [product] ${product.title.substring(0, 50)} (${newMeta.length}c)`);
        state.done[key] = 'ok';
        state.counts.updated++;
        updated++;
        saveState(state);
      }
    } catch (e) {
      console.log(`  ❌ [product] ${product.title}: ${e.message}`);
    }
  }

  return { updated, previews };
}

async function processCollections(state) {
  console.log('\n🗂️  Collections...');
  const collections = await fetchAll('/custom_collections.json', 'custom_collections');
  const smart       = await fetchAll('/smart_collections.json', 'smart_collections');
  const all         = [...collections, ...smart];
  console.log(`   Found ${all.length} collections`);

  let updated = 0;
  const previews = [];

  for (const col of all) {
    const key    = `collection-${col.id}`;
    if (state.done[key] === 'ok') continue;

    const urlPath = `/collections/${col.handle}`;
    const kwData  = getKeywordForUrl(urlPath);

    const existing = await fetchMetaDescription('collections', col.id);
    const current  = existing?.value || null;
    const status   = metaStatus(current);

    if (status === 'ok') {
      state.done[key] = 'ok';
      state.counts.ok++;
      continue;
    }

    const newMeta = metaForCollection(col, kwData);

    if (AUDIT) {
      previews.push({
        type: 'collection', url: urlPath,
        keyword: kwData?.keyword || '(template)',
        status, current: current ? current.substring(0, 80) + '…' : '(none)',
        new_meta: newMeta, length: newMeta.length,
      });
      state.counts[status]++;
      continue;
    }

    try {
      const result = await writeMetaDescription('collections', col.id, newMeta, existing?.id);
      if (result) {
        const action = status === 'missing' ? '✅' : '✏️ ';
        console.log(`  ${action} [collection] ${col.title} (${newMeta.length}c)`);
        state.done[key] = 'ok';
        state.counts.updated++;
        updated++;
        saveState(state);
      }
    } catch (e) {
      console.log(`  ❌ [collection] ${col.title}: ${e.message}`);
    }
  }

  return { updated, previews };
}

async function processBlogs(state) {
  console.log('\n📝 Blog articles...');
  const blogs = await fetchAll('/blogs.json', 'blogs');
  let updated = 0;
  const previews = [];

  for (const blog of blogs) {
    const articles = await fetchAll(`/blogs/${blog.id}/articles.json`, 'articles');
    console.log(`   Blog "${blog.title}": ${articles.length} articles`);

    for (const article of articles) {
      const key    = `article-${article.id}`;
      if (state.done[key] === 'ok') continue;

      const urlPath = `/blogs/${blog.handle}/${article.handle}`;
      const kwData  = getKeywordForUrl(urlPath);

      const existing = await fetchMetaDescription(`blogs/${blog.id}/articles`, article.id);
      const current  = existing?.value || null;
      const status   = metaStatus(current);

      if (status === 'ok') {
        state.done[key] = 'ok';
        state.counts.ok++;
        continue;
      }

      const newMeta = metaForArticle(article, kwData);

      if (AUDIT) {
        previews.push({
          type: 'article', url: urlPath,
          keyword: kwData?.keyword || '(template)',
          status, current: current ? current.substring(0, 80) + '…' : '(none)',
          new_meta: newMeta, length: newMeta.length,
        });
        state.counts[status]++;
        continue;
      }

      try {
        const result = await writeMetaDescription(`blogs/${blog.id}/articles`, article.id, newMeta, existing?.id);
        if (result) {
          const action = status === 'missing' ? '✅' : '✏️ ';
          console.log(`  ${action} [article] ${article.title.substring(0, 50)} (${newMeta.length}c)`);
          state.done[key] = 'ok';
          state.counts.updated++;
          updated++;
          saveState(state);
        }
      } catch (e) {
        console.log(`  ❌ [article] ${article.title}: ${e.message}`);
      }
    }
  }

  return { updated, previews };
}

async function processPages(state) {
  console.log('\n📄 Static pages...');
  const pages = await fetchAll('/pages.json', 'pages');
  console.log(`   Found ${pages.length} pages`);

  let updated = 0;
  const previews = [];

  for (const page of pages) {
    const key  = `page-${page.id}`;
    if (state.done[key] === 'ok') continue;

    const existing = await fetchMetaDescription('pages', page.id);
    const current  = existing?.value || null;
    const status   = metaStatus(current);

    if (status === 'ok') {
      state.done[key] = 'ok';
      state.counts.ok++;
      continue;
    }

    const newMeta = metaForPage(page);

    if (AUDIT) {
      previews.push({
        type: 'page', url: `/pages/${page.handle}`,
        keyword: '(template)',
        status, current: current ? current.substring(0, 80) + '…' : '(none)',
        new_meta: newMeta, length: newMeta.length,
      });
      state.counts[status]++;
      continue;
    }

    try {
      const result = await writeMetaDescription('pages', page.id, newMeta, existing?.id);
      if (result) {
        const action = status === 'missing' ? '✅' : '✏️ ';
        console.log(`  ${action} [page] ${page.title} (${newMeta.length}c)`);
        state.done[key] = 'ok';
        state.counts.updated++;
        updated++;
        saveState(state);
      }
    } catch (e) {
      console.log(`  ❌ [page] ${page.title}: ${e.message}`);
    }
  }

  return { updated, previews };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const modeStr = AUDIT ? 'AUDIT to no changes will be made' : 'LIVE';
  if (!TOKEN) { console.error('❌ SHOPIFY_ADMIN_TOKEN not set'); process.exit(1); }
  console.log(`\n📋 Meta Description Generator: ${BRAND}`);
  console.log(`   ${new Date().toLocaleString()}`);
  console.log(`   Mode: ${modeStr}`);
  console.log(`   Target length: ${META_MIN}-${META_MAX} characters`);
  console.log(`   Keyword map: ${Object.keys(URL_KEYWORD_MAP).length} URLs\n`);

  const state      = loadState();
  let totalUpdated = 0;
  let allPreviews  = [];

  const runAll         = !PRODUCTS_ONLY && !COLLECTIONS_ONLY && !BLOGS_ONLY && !PAGES_ONLY;
  const runProducts    = runAll || PRODUCTS_ONLY;
  const runCollections = runAll || COLLECTIONS_ONLY;
  const runBlogs       = runAll || BLOGS_ONLY;
  const runPages       = runAll || PAGES_ONLY;

  if (runProducts)    { const r = await processProducts(state);    totalUpdated += r.updated; allPreviews.push(...r.previews); }
  if (runCollections) { const r = await processCollections(state); totalUpdated += r.updated; allPreviews.push(...r.previews); }
  if (runBlogs)       { const r = await processBlogs(state);       totalUpdated += r.updated; allPreviews.push(...r.previews); }
  if (runPages)       { const r = await processPages(state);       totalUpdated += r.updated; allPreviews.push(...r.previews); }

  console.log('\n' + '═'.repeat(70));

  if (AUDIT) {
    const byStatus = { missing: [], too_short: [], too_long: [] };
    allPreviews.forEach(p => (byStatus[p.status] || []).push(p));
    const byType = {};
    allPreviews.forEach(p => { byType[p.type] = (byType[p.type] || 0) + 1; });

    console.log(`📊 Meta descriptions needing work: ${allPreviews.length}`);
    Object.entries(byType).forEach(([t, n]) => console.log(`   ${t}: ${n}`));
    console.log(`\n   Missing:   ${byStatus.missing.length}`);
    console.log(`   Too short: ${byStatus.too_short.length}`);
    console.log(`   Too long:  ${byStatus.too_long.length}`);

    const kwAnchored = allPreviews.filter(p => p.keyword !== '(template)').length;
    console.log(`\n   Keyword-anchored:  ${kwAnchored}`);
    console.log(`   Template fallback: ${allPreviews.length - kwAnchored}`);

    console.log('\n── Sample previews ────────────────────────────────────────────────');
    const samples = [
      ...allPreviews.filter(p => p.keyword !== '(template)').slice(0, 5),
      ...allPreviews.filter(p => p.keyword === '(template)').slice(0, 4),
    ].slice(0, 8);

    samples.forEach(p => {
      const tag = p.keyword !== '(template)' ? `[kw: ${p.keyword}]` : '[template]';
      console.log(`\n  ${p.type.toUpperCase()} ${p.status.toUpperCase()} ${tag}`);
      console.log(`  Was (${p.current.length}c): "${p.current}"`);
      console.log(`  Now (${p.length}c): "${p.new_meta}"`);
    });

    const rangeOk = allPreviews.filter(p => p.length >= META_MIN && p.length <= META_MAX).length;
    console.log(`\n\n✅ ${rangeOk}/${allPreviews.length} generated descriptions hit the 140-160 char target`);
    console.log('\nRun without --audit to apply all changes.');
  } else {
    console.log(`✅ Meta descriptions updated: ${totalUpdated}`);
    console.log(`   Progress saved → ${STATE_FILE}`);
  }

  console.log('═'.repeat(70));
}

if (require.main === module) {
  main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
}

module.exports = { fitMeta, metaStatus, metaForProduct, metaForCollection, metaForArticle, metaForPage, getKeywordForUrl, getTypeDescriptor, extractQualityModifiers, META_MIN, META_MAX };

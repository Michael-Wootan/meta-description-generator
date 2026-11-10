#!/usr/bin/env node
// Offline tests for the length rules and the templates. No store needed.
const assert = require('assert');
const path = require('path');
process.env.CONFIG_DIR = path.resolve(__dirname, 'fixtures');
delete process.env.COMPANY_NAME;
const m = require('../src/generate-meta-descriptions.js');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const inRange = s => s.length >= m.META_MIN && s.length <= m.META_MAX;

t('existing descriptions are classified by length', () => {
  assert.strictEqual(m.metaStatus(''), 'missing');
  assert.strictEqual(m.metaStatus(null), 'missing');
  assert.strictEqual(m.metaStatus('Too short.'), 'too_short');
  assert.strictEqual(m.metaStatus('x'.repeat(150)), 'ok');
  assert.strictEqual(m.metaStatus('x'.repeat(161)), 'too_long');
});

t('a description already in range is returned unchanged', () => {
  const s = 'A'.repeat(70) + ' ' + 'B'.repeat(75) + '.';
  assert.strictEqual(m.fitMeta(s), s);
});

t('a long description is cut at a sentence end inside the range', () => {
  const s = 'Shop the complete range of single origin coffees at the roastery today. Every bag is roasted to order in small batches and packed the same day. Then comes a third sentence that will not fit at all.';
  const out = m.fitMeta(s);
  assert.ok(inRange(out), String(out.length));
  assert.ok(out.endsWith('packed the same day.'));
});

t('with no sentence end in range it falls back to a whole-word cut', () => {
  const out = m.fitMeta('word '.repeat(60));
  assert.ok(out.length <= m.META_MAX);
  assert.ok(out.endsWith('word'));
});

t('keyword map lookups ignore a trailing slash and query string', () => {
  assert.strictEqual(m.getKeywordForUrl('/products/espresso-blend/').keyword, 'espresso beans');
  assert.strictEqual(m.getKeywordForUrl('/products/espresso-blend?variant=1').keyword, 'espresso beans');
  assert.strictEqual(m.getKeywordForUrl('/products/unknown'), null);
});

t('the longest matching type descriptor wins', () => {
  assert.strictEqual(m.getTypeDescriptor('Cold Brew Concentrate 32oz', ''), 'ready-to-dilute cold brew');
  assert.strictEqual(m.getTypeDescriptor('Coffee Concentrate', ''), 'liquid coffee concentrate');
  assert.strictEqual(m.getTypeDescriptor('Gift Card', ''), null);
});

t('quality modifiers are read from the product title', () => {
  assert.deepStrictEqual(m.extractQualityModifiers('Organic Single-Origin Kenya'), ['single-origin', 'organic']);
});

t('a transactional product leads with "Buy" and the target keyword', () => {
  const out = m.metaForProduct({ title: 'Ethiopia Natural Light Roast', product_type: 'Coffee' }, m.getKeywordForUrl('/products/ethiopia-natural-light-roast'));
  assert.ok(out.startsWith('Buy Ethiopian light roast coffee online at Acme Supply Co.'));
  assert.ok(inRange(out), String(out.length));
});

t('a commercial product leads with "Shop" and the target keyword', () => {
  const out = m.metaForProduct({ title: 'Espresso Blend', product_type: 'Coffee' }, m.getKeywordForUrl('/products/espresso-blend'));
  assert.ok(out.startsWith('Shop espresso beans at Acme Supply Co.'));
  assert.ok(inRange(out), String(out.length));
});

t('a product with no keyword uses its title, and wholesale products get their own closing', () => {
  const plain = m.metaForProduct({ title: 'Colombia Huila Organic', product_type: 'Coffee' }, null);
  assert.ok(plain.startsWith('Shop Colombia Huila Organic at Acme Supply Co.'));
  const whole = m.metaForProduct({ title: 'Wholesale House Blend 5 lb', product_type: 'Coffee' }, null);
  assert.ok(whole.includes('Request a quote'));
});

t('a brand name ending in a period does not produce a double period', () => {
  const out = m.metaForCollection({ title: 'Single Origin' }, m.getKeywordForUrl('/collections/single-origin'));
  assert.ok(!out.includes('..'));
  assert.ok(inRange(out), String(out.length));
});

t('collection titles drop their suffix when used without a keyword', () => {
  assert.ok(m.metaForCollection({ title: 'Decaf - All Roasts' }, null).startsWith('Browse Decaf at '));
});

t('article titles are kept whole when they fit', () => {
  const out = m.metaForArticle({ title: 'How to Store Coffee Beans So They Stay Fresh' }, m.getKeywordForUrl('/blogs/news/how-to-store-coffee-beans'));
  assert.ok(out.includes('How to Store Coffee Beans So They Stay Fresh:'));
});

t('static pages use their configured description with the brand filled in', () => {
  const out = m.metaForPage({ title: 'About Us' });
  assert.ok(out.startsWith('Acme Supply Co. is a specialty coffee roaster'));
  assert.ok(!out.includes('{brand}'));
});

console.log(`\n${n} tests passed`);

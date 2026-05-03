const axios = require('axios');
const cheerio = require('cheerio');

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const BASE_URL = 'https://www.startupgrantsindia.com';
const MAX_PAGES = 8;
const PER_PAGE_DELAY_MS = 800;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Hrefs that are never opportunity detail pages
const NOISE_HREF_PATTERNS = [
  /\/software-deals/,
  /\/events/,
  /\/competitions/,
  /\/cdn-cgi\//,
  /\/privacy-policy/,
  /\/terms-of-service/,
  /\/providers\//,
  /\/type\//,
  /\/stage\//,
  /\/state\//,
  /\/industry\//,
  /\/eligibility\//,
  /\?amountMin=/,
  /\?page=/,
  /whatsapp\.com/,
];

// ─── AMOUNT NORMALIZER ───────────────────────────────────────────────────────

function extractAmount(text) {
  if (!text) return 'Variable';

  const inrPatterns = [
    /(?:up\s*to\s*)?₹\s*([\d,.]+)\s*(Cr|Crore|Crores)/i,
    /(?:up\s*to\s*)?₹\s*([\d,.]+)\s*(L|Lakhs?|Lakh)/i,
    /(?:up\s*to\s*)?₹\s*([\d,.]+)\s*(K|Thousand)/i,
    /(?:up\s*to\s*)?₹\s*([\d,.]+)/i,
  ];

  for (const rx of inrPatterns) {
    const m = text.match(rx);
    if (m) {
      const num = m[1].replace(/,/g, '');
      let suffix = (m[2] || '').trim();
      if (/^cr/i.test(suffix)) suffix = 'Cr';
      else if (/^l/i.test(suffix)) suffix = 'Lakhs';
      else if (/^k|thousand/i.test(suffix)) suffix = 'K';
      else suffix = '';
      const prefix = /up\s*to|upto/i.test(text) ? 'Up to ' : '';
      return `${prefix}₹${num}${suffix ? ' ' + suffix : ''}`;
    }
  }

  const usdMatch = text.match(/(?:up\s*to\s*)?\$\s*([\d,.]+)\s*(M|K|Million|Billion)?/i);
  if (usdMatch) {
    const num = usdMatch[1].replace(/,/g, '');
    let suffix = (usdMatch[2] || '').trim();
    if (/^m/i.test(suffix)) suffix = 'M';
    else if (/^k/i.test(suffix)) suffix = 'K';
    else if (/^b/i.test(suffix)) suffix = 'B';
    const prefix = /up\s*to/i.test(text) ? 'Up to ' : '';
    return `${prefix}$${num}${suffix}`;
  }

  return 'Variable';
}

// ─── DEADLINE NORMALIZER ─────────────────────────────────────────────────────

function extractDeadline(text) {
  if (!text) return 'Rolling';
  if (/rolling\s*(basis)?/i.test(text)) return 'Rolling';
  if (/closes\s*today/i.test(text)) {
    return new Date().toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  const dateMatch = text.match(
    /(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:[,\s]+(\d{4}))?/i
  );
  if (dateMatch) {
    return `${dateMatch[1]} ${dateMatch[2]}, ${dateMatch[3] || new Date().getFullYear()}`;
  }

  return 'Rolling';
}

// ─── SLUG EXTRACTOR ──────────────────────────────────────────────────────────

function slugFromUrl(url) {
  try {
    const u = new URL(url, BASE_URL);
    return u.pathname.replace(/^\//, '').replace(/\/$/, '');
  } catch {
    return '';
  }
}

// ─── OPPORTUNITY CARD PARSER ─────────────────────────────────────────────────

/**
 * The site renders opportunity cards as:
 *   <div class="group relative rounded-xl border ..."> (the card container)
 *     <h2><a href="/slug">Title</a></h2>
 *     <a href="/providers/...">Provider Name</a>
 *     <a href="/type/...">grant|funding|accelerator|incubation</a>
 *     (text with amount/deadline)
 *     <p>Description text</p>
 *     <a href="/stage/...">Idea|MVP|Early Revenue|Growth|Scaling</a>
 *     <a href="/slug">Details</a>
 *   </div>
 *
 * We exploit this exact structure for precise extraction.
 */
function parseListingPage(html) {
  const $ = cheerio.load(html);
  const items = [];
  const seenSlugs = new Set();

  // Find all card containers — they have classes 'group relative rounded-xl'
  const cards = $('div.group.relative');

  cards.each((_, cardEl) => {
    const $card = $(cardEl);

    // 1. Title + Link from <h2> <a>
    const $titleLink = $card.find('h2 a').first();
    if (!$titleLink.length) return;
    
    const href = $titleLink.attr('href') || '';
    const absoluteUrl = href.startsWith('http') ? href : BASE_URL + href;
    
    // Skip noise
    if (NOISE_HREF_PATTERNS.some(rx => rx.test(href))) return;
    
    const title = $titleLink.text().trim();
    if (!title || title.length < 5) return;
    
    const slug = slugFromUrl(href);
    if (!slug || seenSlugs.has(slug)) return;
    seenSlugs.add(slug);

    // 2. Provider from /providers/ links
    const providers = [];
    $card.find('a[href*="/providers/"]').each((_, el) => {
      const name = $(el).text().trim();
      if (name && name.length > 2 && !providers.includes(name)) providers.push(name);
    });

    // 3. Type from /type/ links
    let type = 'Grant';
    const $typeLink = $card.find('a[href*="/type/"]').first();
    if ($typeLink.length) {
      const rawType = $typeLink.text().trim().toLowerCase();
      const typeMap = {
        grant: 'Grant',
        funding: 'Funding',
        accelerator: 'Accelerator',
        incubation: 'Incubation',
        contest: 'Contest',
        fellowship: 'Fellowship',
      };
      type = typeMap[rawType] || rawType.charAt(0).toUpperCase() + rawType.slice(1);
    }

    // 4. Stage from /stage/ links
    let stage = '';
    const $stageLink = $card.find('a[href*="/stage/"]').first();
    if ($stageLink.length) {
      stage = $stageLink.text().trim();
    }

    // 5. Full card text for amount, deadline, and description extraction
    const cardText = $card.text();

    // 6. Amount
    const amount = extractAmount(cardText);

    // 7. Deadline
    const deadline = extractDeadline(cardText);

    // 8. Description: find <p> or the descriptive sentence
    //    It's the text between the type badge and the stage badge
    let description = '';
    $card.find('p').each((_, pEl) => {
      const pText = $(pEl).text().trim();
      if (pText.length > 15 && pText.length < 500) {
        description = pText;
      }
    });

    // Clean description from badge/noise text
    const cleanDesc = (txt) => txt
      .replace(/·/g, ' ')
      .replace(/(High Chance|Fast Funding|Easy Apply|Easy|Sector|Eligibility|Apply|Details)/gi, '')
      .replace(/(Closes today!?|Rolling basis)/gi, '')
      .replace(/Upto\s*₹[\d,.]+\s*(Cr|Lakhs?|L|K)?/gi, '')
      .replace(/Up to\s*₹[\d,.]+\s*(Cr|Lakhs?|L|K)?/gi, '')
      .replace(/₹[\d,.]+\s*(Cr|Lakhs?|L|K)?/gi, '')
      .replace(/(grant|funding|accelerator|incubation|contest|fellowship)\b/gi, '')
      .replace(/(Idea|MVP|Early Revenue|Growth|Scaling|Growth \/ PMF)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    description = cleanDesc(description);

    // Fallback: extract description from card text
    if (!description || description.length < 15) {
      const stripped = cardText
        .replace(new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '');
      description = cleanDesc(stripped).substring(0, 300);
    }

    // Final guard: if still empty, use title
    if (!description || description.length < 10) {
      description = title;
    }

    items.push({
      title,
      description: description.substring(0, 500),
      provider: providers.join(', ') || 'Startup Grants India',
      type,
      stage,
      amount,
      deadline,
      link: absoluteUrl,
      slug,
    });
  });

  // Fallback: if no cards found (layout change?), parse h2 > a links
  if (items.length === 0) {
    console.warn('⚠️  No cards found via div.group.relative — using h2 fallback');
    $('h2').each((_, headEl) => {
      const $link = $(headEl).find('a').first();
      if (!$link.length) return;
      
      const href = $link.attr('href') || '';
      if (NOISE_HREF_PATTERNS.some(rx => rx.test(href))) return;
      if (!/^\/[a-z]/.test(href)) return;
      
      const title = $link.text().trim();
      const slug = slugFromUrl(href);
      if (!title || title.length < 5 || !slug || seenSlugs.has(slug)) return;
      seenSlugs.add(slug);

      items.push({
        title,
        description: title,
        provider: 'Startup Grants India',
        type: 'Grant',
        stage: '',
        amount: 'Variable',
        deadline: 'Rolling',
        link: href.startsWith('http') ? href : BASE_URL + href,
        slug,
      });
    });
  }

  return items;
}

// ─── MULTI-PAGE SCRAPER ──────────────────────────────────────────────────────

async function fetchPage(pageNum, retryCount = 0) {
  const url = pageNum === 1 ? BASE_URL + '/' : `${BASE_URL}/?page=${pageNum}`;
  
  try {
    console.log(`📄 Fetching page ${pageNum}${retryCount > 0 ? ` (retry ${retryCount}/${MAX_RETRIES})` : ''}...`);
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      },
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: (status) => status < 500, // Don't throw for 4xx errors
    });

    if (response.status === 429) {
      console.warn(`⚠️  Rate limited on page ${pageNum}. Waiting before retry...`);
      await new Promise(r => setTimeout(r, 5000));
      if (retryCount < MAX_RETRIES) {
        return fetchPage(pageNum, retryCount + 1);
      }
      return [];
    }

    if (response.status !== 200) {
      console.warn(`⚠️  Page ${pageNum} returned HTTP ${response.status}`);
      return [];
    }

    // Validate HTML content
    if (!response.data || response.data.length < 1000) {
      console.warn(`⚠️  Page ${pageNum} returned insufficient data (${response.data?.length || 0} bytes)`);
      return [];
    }

    const items = parseListingPage(response.data);
    console.log(`✅ Page ${pageNum}: Successfully parsed ${items.length} items`);
    return items;
    
  } catch (err) {
    console.error(`❌ Error fetching page ${pageNum} (attempt ${retryCount + 1}/${MAX_RETRIES + 1}):`, err.message);
    
    if (retryCount < MAX_RETRIES) {
      const delay = RETRY_DELAY_MS * Math.pow(2, retryCount); // Exponential backoff
      console.log(`⏳ Retrying page ${pageNum} in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
      return fetchPage(pageNum, retryCount + 1);
    }
    
    console.error(`💀 Failed to fetch page ${pageNum} after ${MAX_RETRIES + 1} attempts`);
    return [];
  }
}

async function scrapeStartupGrants() {
  console.log(`🚀 Starting enhanced production scrape of ${BASE_URL} (up to ${MAX_PAGES} pages, ${MAX_RETRIES} retries each)...`);
  const seen = new Set();
  let allItems = [];
  let consecutiveEmptyPages = 0;
  const maxEmptyPages = 3; // Stop after 3 consecutive empty pages

  for (let page = 1; page <= MAX_PAGES; page++) {
    try {
      const items = await fetchPage(page);
      
      // Filter duplicates
      const newItems = items.filter(item => {
        if (!item.slug || seen.has(item.slug)) return false;
        seen.add(item.slug);
        return true;
      });

      // Validate items before adding
      const validItems = newItems.filter(item => {
        return item.title && item.title.length > 5 && 
               item.slug && 
               item.link && item.link.startsWith('http');
      });

      allItems = allItems.concat(validItems);
      
      console.log(`   � Page ${page}: ${items.length} raw → ${newItems.length} new → ${validItems.length} valid (total ${allItems.length})`);

      // Smart pagination stop
      if (validItems.length === 0) {
        consecutiveEmptyPages++;
        if (consecutiveEmptyPages >= maxEmptyPages) {
          console.log(`   🛑 ${maxEmptyPages} consecutive empty pages. Stopping pagination.`);
          break;
        }
      } else {
        consecutiveEmptyPages = 0;
      }

      // Progress check - if we're getting very few items, maybe stop early
      if (page > 3 && validItems.length < 2) {
        console.log(`   📉 Low yield on page ${page} (${validItems.length} items). Checking if pagination should continue...`);
      }

      // Rate limiting
      if (page < MAX_PAGES) {
        await new Promise(r => setTimeout(r, PER_PAGE_DELAY_MS + Math.random() * 500)); // Add jitter
      }
      
    } catch (error) {
      console.error(`💥 Critical error on page ${page}:`, error.message);
      consecutiveEmptyPages++;
      if (consecutiveEmptyPages >= maxEmptyPages) {
        console.log(`   🛑 Too many errors. Stopping scrape.`);
        break;
      }
    }
  }

  // Final validation
  const finalValidItems = allItems.filter(item => 
    item.title && item.title.length > 5 && 
    item.slug && 
    item.link && item.link.startsWith('http') &&
    item.provider
  );

  console.log(`✅ Scrape complete: ${finalValidItems.length}/${allItems.length} valid opportunities collected.`);
  
  // Log statistics
  const typeCounts = {};
  finalValidItems.forEach(item => {
    typeCounts[item.type] = (typeCounts[item.type] || 0) + 1;
  });
  console.log('📈 Opportunity types:', typeCounts);
  
  return finalValidItems;
}

// ─── DETAIL PAGE SCRAPER ─────────────────────────────────────────────────────

async function scrapeDetails(link, retryCount = 0) {
  try {
    console.log(`🔍 Scraping details for ${link}${retryCount > 0 ? ` (retry ${retryCount}/${MAX_RETRIES})` : ''}...`);
    
    const response = await axios.get(link, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache'
      },
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: (status) => status < 500,
    });

    if (response.status === 429) {
      console.warn(`⚠️  Rate limited for details ${link}. Waiting...`);
      await new Promise(r => setTimeout(r, 5000));
      if (retryCount < MAX_RETRIES) {
        return scrapeDetails(link, retryCount + 1);
      }
      return '';
    }

    if (response.status !== 200) {
      console.warn(`⚠️  Detail scrape for ${link} returned ${response.status}`);
      return '';
    }

    if (!response.data || response.data.length < 500) {
      console.warn(`⚠️  Detail page ${link} returned insufficient data`);
      return '';
    }

    const $ = cheerio.load(response.data);
    
    // Remove unwanted elements more comprehensively
    $('script, style, noscript, nav, footer, header, iframe, svg, .sidebar, .ads, .advertisement, .popup, .modal').remove();
    
    // Try multiple selectors for main content
    const $main = $('main, article, [role="main"], .main-content, .content, .post-content').first();
    const rawText = ($main.length ? $main.text() : $('body').text())
      .replace(/(Loading\.\.\.|Sign in or create|Coming Soon|COMING SOON|404|Page not found)/gi, '')
      .replace(/(active|apply now|learn more|browse deals|explore perks|click here|read more)/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (rawText.length < 50) {
      console.warn(`⚠️  Detail result for ${link} is suspiciously short (${rawText.length} chars)`);
      return '';
    }

    const cleanedText = rawText.substring(0, 8000);
    console.log(`✅ Successfully extracted ${cleanedText.length} characters from ${link}`);
    return cleanedText;
    
  } catch (err) {
    console.error(`❌ Failed reading details for ${link} (attempt ${retryCount + 1}/${MAX_RETRIES + 1}):`, err.message);
    
    if (retryCount < MAX_RETRIES) {
      const delay = RETRY_DELAY_MS * Math.pow(2, retryCount);
      console.log(`⏳ Retrying details for ${link} in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
      return scrapeDetails(link, retryCount + 1);
    }
    
    console.error(`💀 Failed to get details for ${link} after ${MAX_RETRIES + 1} attempts`);
    return '';
  }
}

function extractApplyLinkFromHtml(html, pageUrl) {
  const $ = cheerio.load(html);
  let best = '';
  const isValidApplyUrl = (rawUrl) => {
    try {
      const url = new URL(rawUrl);
      const host = url.hostname.replace(/^www\./, '');
      if (host.includes('startupgrantsindia.com')) return false;
      if (host.includes('googletagmanager.com') || host.includes('google-analytics.com')) return false;
      if (host.includes('google.com') && url.pathname.includes('/ns.html')) return false;
      if (rawUrl.includes('/cdn-cgi/')) return false;
      return true;
    } catch {
      return false;
    }
  };

  $('a[href]').each((_, el) => {
    const $el = $(el);
    const href = ($el.attr('href') || '').trim();
    const label = $el.text().replace(/\s+/g, ' ').trim().toLowerCase();
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;

    const absoluteUrl = new URL(href, pageUrl).toString();
    const hostname = new URL(absoluteUrl).hostname;
    const isStartupGrants = hostname.includes('startupgrantsindia.com');
    const looksLikeApply = /apply|register|submit|nominate|application/.test(label) || /apply|register|submit|nominate|application/.test(href.toLowerCase());

    if (looksLikeApply && !isStartupGrants && isValidApplyUrl(absoluteUrl)) {
      best = absoluteUrl;
      return false;
    }
  });

  if (!best) {
    $('script, style, noscript, iframe').remove();
    const text = $('body').text();
    const matches = text.match(/https?:\/\/[^\s)"'<]+/ig) || [];
    best = matches.find(isValidApplyUrl) || '';
  }

  return best;
}

function parseJsonLdGraph(html) {
  const $ = cheerio.load(html);
  const nodes = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) nodes.push(...parsed);
      else if (Array.isArray(parsed['@graph'])) nodes.push(...parsed['@graph']);
      else nodes.push(parsed);
    } catch {
      // Ignore malformed analytics or framework payloads.
    }
  });

  return nodes;
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function extractBetween(text, start, endMarkers = []) {
  const startIndexes = [];
  let cursor = text.indexOf(start);
  while (cursor !== -1) {
    startIndexes.push(cursor);
    cursor = text.indexOf(start, cursor + start.length);
  }
  if (startIndexes.length === 0) return '';

  const candidates = startIndexes.map(startIndex => {
    const contentStart = startIndex + start.length;
    const endIndex = endMarkers
      .map(marker => text.indexOf(marker, contentStart))
      .filter(index => index !== -1)
      .sort((a, b) => a - b)[0] || text.length;
    return { startIndex, endIndex, distance: endIndex - contentStart };
  });

  const { startIndex, endIndex } = candidates.sort((a, b) => a.distance - b.distance)[0];
  if (startIndex === -1) return '';
  const contentStart = startIndex + start.length;

  return dedupeSentences(text.slice(contentStart, endIndex)
    .replace(/Sign in or create a free account to read everything\./gi, '')
    .replace(/Sign up to unlock (eligibility|benefits)/gi, '')
    .replace(/Sign up to view full details/gi, '')
    .replace(/\s+/g, ' ')
    .trim());
}

function dedupeSentences(text) {
  if (!text) return '';
  const parts = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  const seen = new Set();
  const unique = [];

  for (const part of parts) {
    const sentence = part.trim();
    const key = sentence.toLowerCase();
    if (!sentence || seen.has(key)) continue;
    seen.add(key);
    unique.push(sentence);
  }

  return unique.join(' ').trim();
}

function extractOpportunityDetailDataFromHtml(html, pageUrl) {
  const $ = cheerio.load(html);
  const graph = parseJsonLdGraph(html);
  const grant = graph.find(node => {
    const type = node['@type'];
    return type === 'MonetaryGrant' || (Array.isArray(type) && type.includes('MonetaryGrant'));
  }) || {};

  const applyUrl = grant.potentialAction?.target || extractApplyLinkFromHtml(html, pageUrl);

  $('script, style, noscript, iframe, svg').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();

  const aboutIndex = text.indexOf('About this grant');
  const headerText = aboutIndex === -1 ? text : text.slice(0, aboutIndex);
  const typeIndex = headerText.lastIndexOf('Type');
  const locationIndex = headerText.lastIndexOf('Location');
  const applyIndex = headerText.indexOf('Apply Now', locationIndex);
  const closingIndex = headerText.lastIndexOf('Closing date', typeIndex === -1 ? undefined : typeIndex);
  const description = closingIndex !== -1 && typeIndex !== -1
    ? headerText.slice(closingIndex + 'Closing date'.length, typeIndex).replace(/Stage[A-Za-z0-9, /&+-]+$/i, '').trim()
    : '';
  const type = typeIndex !== -1 && locationIndex !== -1
    ? headerText.slice(typeIndex + 'Type'.length, locationIndex).trim()
    : '';
  const location = locationIndex !== -1
    ? headerText.slice(locationIndex + 'Location'.length, applyIndex === -1 ? headerText.length : applyIndex).trim()
    : '';

  const about = extractBetween(text, 'About this grant', ['Provider', 'AI Overview', 'Eligibility']);
  const eligibility = extractBetween(text, 'Eligibility', ['Benefits & Funding']);
  const benefits = extractBetween(text, 'Benefits & Funding', ['Timelines & Process']);
  const timeline = extractBetween(text, 'Timelines & Process', ['Apply for this program', 'Startup Deals', 'Similar Grants']);

  const amountMatch = benefits.match(/Amount(.+?)Fund Type/) || benefits.match(/Offers\s+(.+?)\s+as/i);
  const amount = amountMatch ? amountMatch[1].trim() : extractAmount(benefits || text);
  const deadline = formatDate(grant.validThrough) || extractDeadline(timeline || text);

  return {
    title: grant.name || '',
    provider: grant.funder?.name || '',
    description,
    about,
    eligibility,
    benefits,
    timeline,
    type,
    amount,
    deadline,
    location,
    external_apply_url: applyUrl || '',
    raw_scraped_text: text.substring(0, 8000)
  };
}

async function scrapeApplyLink(link, retryCount = 0) {
  try {
    const response = await axios.get(link, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache'
      },
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: (status) => status < 500,
    });

    if (response.status === 429 && retryCount < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 5000));
      return scrapeApplyLink(link, retryCount + 1);
    }

    if (response.status !== 200 || !response.data) return '';
    return extractApplyLinkFromHtml(response.data, link);
  } catch (err) {
    if (retryCount < MAX_RETRIES) {
      const delay = RETRY_DELAY_MS * Math.pow(2, retryCount);
      await new Promise(r => setTimeout(r, delay));
      return scrapeApplyLink(link, retryCount + 1);
    }

    console.warn(`Could not extract apply link for ${link}: ${err.message}`);
    return '';
  }
}

async function scrapeOpportunityDetailData(link, retryCount = 0) {
  try {
    const response = await axios.get(link, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache'
      },
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: (status) => status < 500,
    });

    if (response.status === 429 && retryCount < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 5000));
      return scrapeOpportunityDetailData(link, retryCount + 1);
    }

    if (response.status !== 200 || !response.data) return {};
    return extractOpportunityDetailDataFromHtml(response.data, link);
  } catch (err) {
    if (retryCount < MAX_RETRIES) {
      const delay = RETRY_DELAY_MS * Math.pow(2, retryCount);
      await new Promise(r => setTimeout(r, delay));
      return scrapeOpportunityDetailData(link, retryCount + 1);
    }

    console.warn(`Could not extract detail data for ${link}: ${err.message}`);
    return {};
  }
}

module.exports = {
  scrapeStartupGrants,
  scrapeDetails,
  scrapeApplyLink,
  scrapeOpportunityDetailData,
  extractApplyLinkFromHtml,
  extractOpportunityDetailDataFromHtml
};

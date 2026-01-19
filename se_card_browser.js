/**
 * FFTCG Card Scraper v9.1
 * Fixed: $eval argument limitation (wrap in single object)
 * Added: Icon parsing for ability text ([F], [1], [Dull], etc.)
 * Added: Incremental image downloads
 * Added: --all flag to scrape all sets sequentially
 * Added: Skip existing sets, combined JSON output
 * Fixed: Wait for JS to load cards before declaring error
 */

const { chromium } = require('playwright');
const fs = require('fs').promises;
const path = require('path');

// =============================================================================
// ALL SETS LIST
// =============================================================================

const ALL_SETS = [
    'Legacy Collection',
    'Opus I',
    'Opus II',
    'Opus III',
    'Opus IV',
    'Opus V',
    'Opus VI',
    'Opus VII',
    'Opus VIII',
    'Opus IX',
    'Opus X',
    'Opus XI',
    'Opus XII',
    'Opus XIII',
    'Opus XIV',
    'Crystal Dominion',
    'Emissaries of Light',
    "Rebellion's Call",
    'Resurgence of Power',
    'From Nightmares',
    'Dawn of Heroes',
    'Beyond Destiny',
    'Hidden Hope',
    'Hidden Trials',
    'Hidden Legends',
    'Tears of the Planet',
    'Gunslinger in the Abyss',
    'Journey of Discovery',
    'Promo',
];

// =============================================================================
// CORRECT FILTER SELECTORS (based on actual HTML)
// =============================================================================

const FILTER_SELECTORS = {
    // MULTI-SELECT filters (have .options container)
    set: {
        container: '.filter.set.multi .options',
        itemSelector: '.item[data-value]',
    },
    category: {
        container: '.filter.category.multi .options',
        itemSelector: '.item[data-value]',
    },
    
    // SINGLE-SELECT filters (items are direct children)
    type: {
        container: '.filter.type.select',
        itemSelector: '.item[data-value]',
        values: {
            'Backup': 'backup', 'Crystal': 'crystal', 'Forward': 'forward',
            'Monster': 'monster', 'Summon': 'summon',
        }
    },
    element: {
        container: '.filter.element.select',
        itemSelector: '.item[data-value]',
        values: {
            'Fire': 'fire', 'Ice': 'ice', 'Wind': 'wind', 'Earth': 'earth',
            'Lightning': 'lightning', 'Water': 'water', 'Light': 'light',
            'Dark': 'darkness', 'Darkness': 'darkness',
        }
    },
    rarity: {
        container: '.filter.rarity.select',
        itemSelector: '.item[data-value]',
        values: {
            'Common': 'c', 'Rare': 'r', 'Hero': 'h', 'Legend': 'l',
            'Starter': 's', 'Boss': 'b', 'Promo': 'pr',
            'C': 'c', 'R': 'r', 'H': 'h', 'L': 'l', 'S': 's', 'B': 'b', 'PR': 'pr',
        }
    },
    cost: {
        container: '.filter.cost.select',
        itemSelector: '.item[data-value]',
    },
    flag: {
        container: '.filter.flag.select',
        itemSelector: '.item[data-value]',
        values: { 
            'Special': 'special', 'EX Burst': 'exburst', 'Generic': 'multi',
            'special': 'special', 'exburst': 'exburst', 'multi': 'multi',
        }
    },
};

// Card selector - cards are in .results div
const CARD_SELECTOR = '.results .item[data-code]';
const RESULTS_HEADER = '.results .header span';

const DEFAULT_CONFIG = {
    output: {
        directory: './output',
        downloadImages: true,
        saveJson: true,
        jsonFilename: 'cards.json',
        imageSubdir: 'images',
    },
    filters: {
        sets: null,
        elements: null,
        types: null,
        rarities: null,
        categories: null,
        costs: null,
        flags: null,
        keyword: null,
        code: null,
    },
    scraping: {
        includeCardDetails: true,
        delayBetweenCards: 150,
        delayBetweenPages: 500,
        headless: false,
        timeout: 60000,
    },
    images: {
        quality: 'full',
        concurrent: 5,
    }
};

class FFTCGScraper {
    constructor(config = {}) {
        this.config = this.mergeConfig(DEFAULT_CONFIG, config);
        this.browser = null;
        this.page = null;
        this.cards = [];
    }
    
    log(message, level = 'info') {
        const timestamp = new Date().toISOString().split('T')[1].slice(0, 12);
        const icons = { 'info': 'ℹ️ ', 'debug': '🔍', 'warn': '⚠️ ', 'error': '❌', 'success': '✅' };
        console.log(`[${timestamp}] ${icons[level] || ''} ${message}`);
    }
    
    mergeConfig(defaults, overrides) {
        const result = { ...defaults };
        for (const key of Object.keys(overrides)) {
            if (overrides[key] !== undefined && typeof overrides[key] === 'object' && 
                !Array.isArray(overrides[key]) && overrides[key] !== null) {
                result[key] = this.mergeConfig(defaults[key] || {}, overrides[key]);
            } else if (overrides[key] !== undefined) {
                result[key] = overrides[key];
            }
        }
        return result;
    }
    
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    rarityCodeToName(code) {
        const map = { 'C': 'Common', 'R': 'Rare', 'H': 'Hero', 'L': 'Legend', 
                      'S': 'Starter', 'B': 'Boss', 'P': 'Promo', 'PR': 'Promo' };
        return map[code?.toUpperCase()] || code;
    }
    
    async init() {
        this.log('FFTCG Scraper v9.1 Starting...', 'info');
        this.log(`Output: ${this.config.output.directory}`, 'info');
        this.log(`Filters: ${JSON.stringify(this.config.filters)}`, 'info');
        
        await fs.mkdir(this.config.output.directory, { recursive: true });
        if (this.config.output.downloadImages) {
            await fs.mkdir(path.join(this.config.output.directory, this.config.output.imageSubdir), { recursive: true });
        }
        
        this.browser = await chromium.launch({ headless: this.config.scraping.headless });
        this.page = await this.browser.newPage();
        this.page.setDefaultTimeout(this.config.scraping.timeout);
        
        this.log('Browser launched', 'success');
    }
    
    async close() {
        if (this.browser) {
            await this.browser.close();
            this.log('Browser closed', 'info');
        }
    }
    
    async handleCookieBanner() {
        const cookieSelectors = [
            '.osano-cm-accept-all',
            '.osano-cm-button--type_accept',
            'button:has-text("Accept")',
            'button:has-text("Reject Non-Essential")',
            '.osano-cm-dialog__close',
        ];
        
        for (const selector of cookieSelectors) {
            try {
                const btn = await this.page.$(selector);
                if (btn && await btn.isVisible()) {
                    this.log(`Clicking cookie banner: ${selector}`, 'debug');
                    await btn.click();
                    await this.sleep(500);
                    return true;
                }
            } catch (e) {}
        }
        return false;
    }
    
    async clickSearchButton() {
        const searchSelectors = [
            '.card-search button',
            '.search-btn',
            'button[role="search"]',
            '.card-search',
        ];
        
        for (const selector of searchSelectors) {
            try {
                const btn = await this.page.$(selector);
                if (btn && await btn.isVisible()) {
                    this.log(`Clicking Search button: ${selector}`, 'info');
                    await btn.click();
                    return true;
                }
            } catch (e) {}
        }
        
        this.log('Could not find Search button!', 'warn');
        return false;
    }
    
    async navigateToCardBrowser() {
        const url = 'https://fftcg.square-enix-games.com/en/card-browser';
        this.log(`Navigating to: ${url}`, 'info');
        
        await this.page.goto(url, { waitUntil: 'domcontentloaded' });
        
        this.log('Checking for cookie banner...', 'debug');
        await this.sleep(1000);
        await this.handleCookieBanner();
        
        await this.expandFiltersPanel();
        await this.sleep(500);
        
        this.log('Waiting for filter items...', 'debug');
        try {
            await this.page.waitForSelector('.filter.set.multi .options .item[data-value]', { timeout: 30000 });
            this.log('Filters loaded', 'success');
        } catch (e) {
            this.log('Timeout waiting for filter items, trying to expand filters again...', 'warn');
            await this.expandFiltersPanel();
            await this.sleep(1000);
        }
        
        this.log('Card browser loaded (filters ready, no search yet)', 'success');
    }
    
    async expandFiltersPanel() {
        this.log('Checking if filters panel needs to be expanded...', 'debug');
        
        try {
            await this.page.waitForSelector('.card-filter .toggle, .toggle.noselect', { timeout: 10000 });
            
            const filtersPanel = await this.page.$('.filters');
            if (filtersPanel) {
                const style = await filtersPanel.getAttribute('style');
                const isHidden = style?.includes('display: none') || style?.includes('display:none');
                
                if (!isHidden) {
                    this.log('Filters panel already visible', 'debug');
                    return true;
                }
            }
            
            this.log('Filters panel is hidden, clicking toggle to expand...', 'info');
            
            const toggleSelectors = [
                '.card-filter .toggle',
                '.toggle.noselect',
                '.item.card-filter',
            ];
            
            for (const selector of toggleSelectors) {
                try {
                    const toggleBtn = await this.page.$(selector);
                    if (toggleBtn && await toggleBtn.isVisible()) {
                        await toggleBtn.click();
                        await this.sleep(500);
                        
                        const filtersAfter = await this.page.$('.filters');
                        if (filtersAfter) {
                            const styleAfter = await filtersAfter.getAttribute('style');
                            if (!styleAfter || !styleAfter.includes('display: none')) {
                                this.log('Filters panel expanded successfully', 'success');
                                return true;
                            }
                        }
                    }
                } catch (e) {}
            }
            
            this.log('Could not expand filters panel!', 'error');
            return false;
            
        } catch (e) {
            this.log(`Error expanding filters: ${e.message}`, 'warn');
            return false;
        }
    }
    
    async clickFilterItem(filterType, value) {
        const filterConfig = FILTER_SELECTORS[filterType];
        if (!filterConfig) {
            this.log(`Unknown filter type: ${filterType}`, 'warn');
            return false;
        }
        
        await this.expandFiltersPanel();
        
        let dataValue = value;
        if (filterConfig.values && filterConfig.values[value]) {
            dataValue = filterConfig.values[value];
        }
        
        const selector = `${filterConfig.container} .item[data-value="${dataValue}"]`;
        this.log(`Looking for: ${selector}`, 'debug');
        
        try {
            const element = await this.page.$(selector);
            
            if (!element) {
                this.log(`❌ Element NOT FOUND: ${selector}`, 'error');
                
                const available = await this.page.$$eval(
                    `${filterConfig.container} .item[data-value]`,
                    els => els.slice(0, 10).map(e => e.getAttribute('data-value'))
                ).catch(() => []);
                this.log(`Available ${filterType} values: ${available.join(', ')}...`, 'warn');
                
                return false;
            }
            
            await element.scrollIntoViewIfNeeded();
            await this.sleep(200);
            
            const isVisible = await element.isVisible();
            if (!isVisible) {
                this.log(`Element found but not visible, trying to make it visible...`, 'warn');
                
                await this.page.evaluate((sel) => {
                    const el = document.querySelector(sel);
                    if (el) {
                        el.scrollIntoView({ behavior: 'instant', block: 'center' });
                    }
                }, selector);
                await this.sleep(300);
            }
            
            await element.click({ timeout: 5000 });
            this.log(`✅ Clicked ${filterType}: "${dataValue}"`, 'success');
            
            await this.sleep(200);
            const classes = await element.getAttribute('class');
            if (classes?.includes('selected')) {
                this.log(`Filter "${dataValue}" is now selected`, 'debug');
            }
            
            return true;
            
        } catch (e) {
            this.log(`❌ Error clicking ${filterType}="${value}": ${e.message}`, 'error');
            return false;
        }
    }
    
    async applyFilters() {
        const { filters } = this.config;
        let appliedCount = 0;
        let criticalFilterFailed = false;
        
        await this.expandFiltersPanel();
        
        if (filters.sets?.length > 0) {
            this.log(`Applying SET filter: ${filters.sets.join(', ')}`, 'info');
            for (const set of filters.sets) {
                if (await this.clickFilterItem('set', set)) {
                    appliedCount++;
                } else {
                    this.log(`CRITICAL: Failed to apply SET filter "${set}"!`, 'error');
                    criticalFilterFailed = true;
                }
                await this.sleep(300);
            }
        }
        
        if (criticalFilterFailed) {
            this.log('FATAL: Set filter failed! Aborting to prevent loading ALL cards.', 'error');
            throw new Error('Critical filter (Set) failed to apply. Check if filters panel expanded correctly.');
        }
        
        if (filters.types?.length > 0) {
            this.log(`Applying TYPE filter: ${filters.types.join(', ')}`, 'info');
            for (const type of filters.types) {
                if (await this.clickFilterItem('type', type)) appliedCount++;
                await this.sleep(200);
            }
        }
        
        if (filters.elements?.length > 0) {
            this.log(`Applying ELEMENT filter: ${filters.elements.join(', ')}`, 'info');
            for (const el of filters.elements) {
                if (await this.clickFilterItem('element', el)) appliedCount++;
                await this.sleep(200);
            }
        }
        
        if (filters.rarities?.length > 0) {
            this.log(`Applying RARITY filter: ${filters.rarities.join(', ')}`, 'info');
            for (const rarity of filters.rarities) {
                if (await this.clickFilterItem('rarity', rarity)) appliedCount++;
                await this.sleep(200);
            }
        }
        
        if (filters.categories?.length > 0) {
            this.log(`Applying CATEGORY filter: ${filters.categories.join(', ')}`, 'info');
            for (const cat of filters.categories) {
                if (await this.clickFilterItem('category', cat)) appliedCount++;
                await this.sleep(200);
            }
        }
        
        if (filters.costs?.length > 0) {
            this.log(`Applying COST filter: ${filters.costs.join(', ')}`, 'info');
            for (const cost of filters.costs) {
                if (await this.clickFilterItem('cost', String(cost))) appliedCount++;
                await this.sleep(200);
            }
        }
        
        if (filters.flags?.length > 0) {
            this.log(`Applying FLAG filter: ${filters.flags.join(', ')}`, 'info');
            for (const flag of filters.flags) {
                if (await this.clickFilterItem('flag', flag)) appliedCount++;
                await this.sleep(200);
            }
        }
        
        if (filters.keyword) {
            this.log(`Applying KEYWORD: ${filters.keyword}`, 'info');
            await this.page.fill('input[name="keyword"]', filters.keyword);
            appliedCount++;
        }
        
        if (filters.code) {
            this.log(`Applying CODE: ${filters.code}`, 'info');
            await this.page.fill('input[name="code"]', filters.code);
            appliedCount++;
        }
        
        if (appliedCount > 0) {
            this.log(`Applied ${appliedCount} filter(s), clicking Search...`, 'info');
            await this.clickSearchButton();
            
            // Wait for results to load (either cards appear or results header updates)
            this.log('Waiting for search results to load...', 'debug');
            await this.waitForSearchResults();
            
            const resultText = await this.page.textContent(RESULTS_HEADER).catch(() => null);
            this.log(`Results: ${resultText}`, 'info');
        }
        
        return appliedCount;
    }
    
    async waitForSearchResults(maxWaitMs = 15000) {
        const startTime = Date.now();
        const checkInterval = 500;
        
        while (Date.now() - startTime < maxWaitMs) {
            // Check if cards have loaded
            const cardCount = await this.page.$$(CARD_SELECTOR).then(els => els.length);
            if (cardCount > 0) {
                this.log(`Search results loaded: ${cardCount} cards visible`, 'debug');
                return true;
            }
            
            // Check if results header shows a count (even if cards still loading)
            const headerText = await this.page.textContent(RESULTS_HEADER).catch(() => '');
            const hasCount = /\(\d+\)/.test(headerText);
            if (hasCount) {
                this.log(`Results header updated: ${headerText}`, 'debug');
                // Give a bit more time for cards to render
                await this.sleep(1000);
                return true;
            }
            
            // Check for "No Results" message (valid response, stop waiting)
            const noResults = await this.page.$('.results .empty:not([style*="display: none"])');
            if (noResults && await noResults.isVisible()) {
                this.log('No results message appeared', 'debug');
                return true;
            }
            
            await this.sleep(checkInterval);
        }
        
        this.log(`Timed out waiting for search results after ${maxWaitMs}ms`, 'warn');
        return false;
    }
    
    async getExpectedCount() {
        try {
            const text = await this.page.textContent(RESULTS_HEADER);
            const match = text?.match(/\((?:\d+\/)?(\d+)\)/);
            return match ? parseInt(match[1]) : null;
        } catch (e) {
            return null;
        }
    }
    
    async loadAllCards() {
        this.log('Loading all cards...', 'info');
        
        // Wait for initial cards to load with retries
        let currentCount = 0;
        const maxRetries = 10;
        const retryDelay = 1000;
        
        for (let retry = 0; retry < maxRetries; retry++) {
            currentCount = await this.page.$$(CARD_SELECTOR).then(els => els.length);
            
            if (currentCount > 0) {
                break;
            }
            
            // Check for "No Results" message (valid response, stop retrying)
            const noResults = await this.page.$('.results .empty:not([style*="display: none"])');
            if (noResults && await noResults.isVisible()) {
                const text = await noResults.textContent();
                this.log(`No Results message: "${text}"`, 'warn');
                return 0;
            }
            
            if (retry < maxRetries - 1) {
                this.log(`Waiting for cards to load... (attempt ${retry + 1}/${maxRetries})`, 'debug');
                await this.sleep(retryDelay);
            }
        }
        
        const expectedTotal = await this.getExpectedCount();
        this.log(`Expected total: ${expectedTotal ?? 'unknown'}`, 'info');
        this.log(`Current count: ${currentCount}`, 'info');
        
        const MAX_CARDS_SAFETY = 500;
        
        if (currentCount === 0) {
            this.log('No cards found after waiting! Check if filters returned results.', 'error');
            return 0;
        }
        
        if (!expectedTotal && currentCount >= 50) {
            this.log(`WARNING: No expected count and already ${currentCount} cards. Filter may have failed!`, 'warn');
        }
        
        let previousCount = 0;
        let noChangeCount = 0;
        
        while (noChangeCount < 5) {
            currentCount = await this.page.$$(CARD_SELECTOR).then(els => els.length);
            
            if (!expectedTotal && currentCount >= MAX_CARDS_SAFETY) {
                this.log(`SAFETY STOP: Loaded ${currentCount} cards without known total. Filter may have failed!`, 'warn');
                this.log(`If this is intentional, set a specific filter or increase safety limit.`, 'warn');
                break;
            }
            
            if (expectedTotal && currentCount >= expectedTotal) {
                this.log(`All ${currentCount} cards loaded`, 'success');
                break;
            }
            
            if (currentCount === previousCount) {
                noChangeCount++;
                
                const loadMore = await this.page.$('.results .more:not([style*="display: none"])');
                if (loadMore && await loadMore.isVisible()) {
                    this.log('Clicking Load More...', 'debug');
                    await loadMore.click();
                    await this.sleep(this.config.scraping.delayBetweenPages);
                    noChangeCount = 0;
                    continue;
                }
                
                await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await this.sleep(this.config.scraping.delayBetweenPages);
            } else {
                this.log(`Loaded ${currentCount}/${expectedTotal ?? '?'} cards`, 'info');
                noChangeCount = 0;
            }
            
            previousCount = currentCount;
        }
        
        const finalCount = await this.page.$$(CARD_SELECTOR).then(els => els.length);
        this.log(`Total cards loaded: ${finalCount}`, 'success');
        return finalCount;
    }
    
    async scrapeCardCodes() {
        const items = await this.page.$$(CARD_SELECTOR);
        const codes = [];
        
        for (const item of items) {
            const code = await item.getAttribute('data-code');
            if (code && !codes.includes(code)) {
                codes.push(code);
            }
        }
        
        this.log(`Found ${codes.length} unique card codes`, 'info');
        return codes;
    }
    
    async scrapeCardDetails(cardCode) {
        const card = {
            code: cardCode,
            name: null,
            type: null,
            job: null,
            element: null,
            cost: null,
            power: null,
            rarity: null,
            category: null,
            set: null,
            abilities: '',
            imageUrl: `https://fftcg.cdn.sewest.net/images/cards/full/${cardCode}_eg.jpg`,
        };
        
        try {
            await this.page.click(`${CARD_SELECTOR}[data-code="${cardCode}"]`);
            await this.page.waitForSelector('.overlay', { state: 'visible', timeout: 5000 });
            await this.sleep(300);
            
            try {
                card.name = await this.page.textContent('.overlay .bar .title');
                card.name = card.name?.trim();
            } catch (e) {}
            
            const textSelectors = [
                '.overlay .col.details .text',
                '.overlay .col.details p.text',
                '.overlay .details .text',
                '.overlay p.text',
            ];
            
            for (const selector of textSelectors) {
                try {
                    const abilities = await this.page.$eval(selector, (el, icons) => {
                        const result = [];
                        
                        function processNode(node) {
                            if (node.nodeType === Node.TEXT_NODE) {
                                const text = node.textContent;
                                if (text) result.push(text);
                            } else if (node.nodeType === Node.ELEMENT_NODE) {
                                const elem = node;
                                
                                if (elem.tagName === 'SPAN' && elem.classList.contains('icon')) {
                                    const classes = Array.from(elem.classList);
                                    
                                    if (classes.includes('num')) {
                                        const num = elem.textContent?.trim() || '?';
                                        result.push(`[${num}]`);
                                        return;
                                    }
                                    
                                    for (const cls of classes) {
                                        if (icons.elements[cls]) {
                                            result.push(`[${icons.elements[cls]}]`);
                                            return;
                                        }
                                        if (icons.special[cls]) {
                                            result.push(`[${icons.special[cls]}]`);
                                            return;
                                        }
                                    }
                                    
                                    const iconClass = classes.find(c => c !== 'icon');
                                    if (iconClass) {
                                        result.push(`[${iconClass}]`);
                                    }
                                } else if (elem.tagName === 'SPAN' && elem.classList.contains('italic')) {
                                    result.push(`*${elem.textContent?.trim()}*`);
                                } else if (elem.tagName === 'BR') {
                                    result.push(' ');
                                } else {
                                    for (const child of elem.childNodes) {
                                        processNode(child);
                                    }
                                }
                            }
                        }
                        
                        processNode(el);
                        return result.join('').replace(/\s+/g, ' ').trim();
                    }, {
                        elements: {
                            'fire': 'F', 'ice': 'I', 'wind': 'W', 'earth': 'E',
                            'lightning': 'L', 'water': 'A', 'light': 'Lt', 
                            'dark': 'D', 'darkness': 'D'
                        },
                        special: {
                            'down': 'Dull', 'special': 'S', 'exburst': 'EX', 
                            'c': 'C', 'ability': '', 's': 'S'
                        }
                    });
                    
                    if (abilities) {
                        let processed = abilities
                            .replace(/(\*Priming [^*]+)\*\s*(?:--\s*)?((?:\[[^\]]+\])+)/g, '$1 $2*')
                            .replace(/\*Limit Break\s*--\s*(\d+)\*/g, '*Limit Break $1*')
                            .replace(/\s+/g, ' ')
                            .trim();
                        card.abilities = processed;
                        this.log(`Abilities for ${cardCode}: "${processed.substring(0, 60)}..."`, 'debug');
                        break;
                    }
                } catch (e) {
                    this.log(`Selector ${selector} failed: ${e.message}`, 'debug');
                }
            }
            
            if (!card.abilities) {
                try {
                    const detailsHtml = await this.page.$eval('.overlay', el => {
                        const debugInfo = [];
                        debugInfo.push('Classes found: ' + Array.from(el.querySelectorAll('*')).slice(0, 20).map(e => e.className).filter(c => c).join(', '));
                        const textEl = el.querySelector('.text') || el.querySelector('p.text') || el.querySelector('.col.details');
                        if (textEl) {
                            debugInfo.push('Text element HTML: ' + textEl.outerHTML.substring(0, 300));
                        }
                        return debugInfo.join(' | ');
                    });
                    this.log(`DEBUG ${cardCode} overlay structure: ${detailsHtml}`, 'warn');
                } catch (e) {
                    this.log(`Could not debug overlay: ${e.message}`, 'debug');
                }
            }
            
            const rows = await this.page.$$('.overlay .attributes tr');
            for (const row of rows) {
                try {
                    const cells = await row.$$('td');
                    if (cells.length >= 2) {
                        const labelText = await cells[0].textContent();
                        const label = labelText.toLowerCase().replace(':', '').trim();
                        
                        if (label === 'element') {
                            const iconEls = await cells[1].$$('.icon');
                            if (iconEls.length > 0) {
                                const elements = [];
                                for (const iconEl of iconEls) {
                                    const classes = await iconEl.getAttribute('class');
                                    const elementMatch = classes?.match(/icon\s+(\w+)/);
                                    if (elementMatch) {
                                        const el = elementMatch[1];
                                        elements.push(el.charAt(0).toUpperCase() + el.slice(1));
                                    }
                                }
                                card.element = elements.join('/');
                            }
                            continue;
                        }
                        
                        const value = (await cells[1].textContent()).trim();
                        
                        switch (label) {
                            case 'type': card.type = value; break;
                            case 'job': card.job = value || null; break;
                            case 'cost': card.cost = parseInt(value) || value; break;
                            case 'power': card.power = parseInt(value) || value || null; break;
                            case 'serial type': card.rarity = this.rarityCodeToName(value); break;
                            case 'category': card.category = value; break;
                            case 'set': card.set = value; break;
                            case 'code': break;
                        }
                    }
                } catch (e) {}
            }
            
            await this.page.click('.overlay .close').catch(() => {});
            await this.sleep(100);
            
        } catch (e) {
            this.log(`Error scraping ${cardCode}: ${e.message}`, 'warn');
            await this.page.click('.overlay .close').catch(() => {});
            await this.page.keyboard.press('Escape').catch(() => {});
        }
        
        return card;
    }
    
    async downloadImage(card) {
        if (!card.imageUrl) {
            this.log(`No imageUrl for ${card.code}`, 'debug');
            return false;
        }
        
        const imageDir = path.join(this.config.output.directory, this.config.output.imageSubdir);
        const filepath = path.join(imageDir, `${card.code}.jpg`);
        
        // Check if image already exists
        try {
            await fs.access(filepath);
            this.log(`Image already exists: ${card.code}.jpg`, 'debug');
            return true;
        } catch (e) {
            // File doesn't exist, download it
        }
        
        this.log(`Downloading: ${card.imageUrl} -> ${filepath}`, 'debug');
        
        try {
            await fs.mkdir(imageDir, { recursive: true });
            
            const response = await fetch(card.imageUrl);
            this.log(`Fetch response for ${card.code}: ${response.status} ${response.statusText}`, 'debug');
            
            if (response.ok) {
                const buffer = Buffer.from(await response.arrayBuffer());
                await fs.writeFile(filepath, buffer);
                this.log(`Saved ${card.code}.jpg (${buffer.length} bytes)`, 'debug');
                return true;
            } else {
                this.log(`Image download failed for ${card.code}: HTTP ${response.status}`, 'warn');
            }
        } catch (e) {
            this.log(`Image download error for ${card.code}: ${e.message}`, 'warn');
        }
        
        return false;
    }
    
    async downloadImages(cards) {
        const concurrent = this.config.images.concurrent;
        let success = 0, fail = 0;
        
        const imageDir = path.join(this.config.output.directory, this.config.output.imageSubdir);
        this.log(`Downloading ${cards.length} images to ${imageDir}...`, 'info');
        
        if (cards.length > 0) {
            this.log(`First image URL: ${cards[0].imageUrl}`, 'info');
        }
        
        for (let i = 0; i < cards.length; i += concurrent) {
            const batch = cards.slice(i, i + concurrent);
            const results = await Promise.all(batch.map(c => this.downloadImage(c)));
            success += results.filter(r => r).length;
            fail += results.filter(r => !r).length;
            
            const pct = Math.round((i + batch.length) / cards.length * 100);
            this.log(`Images: ${pct}% (${success} ok, ${fail} failed)`, 'info');
        }
        
        this.log(`Downloaded ${success}/${cards.length} images`, 'success');
    }
    
    async saveJson(cards, partial = false) {
        await fs.mkdir(this.config.output.directory, { recursive: true });
        
        const filename = partial 
            ? this.config.output.jsonFilename.replace('.json', '_partial.json')
            : this.config.output.jsonFilename;
        const filepath = path.join(this.config.output.directory, filename);
        
        const output = {
            scraped_at: new Date().toISOString(),
            filters: this.config.filters,
            total: cards.length,
            complete: !partial,
            cards,
        };
        await fs.writeFile(filepath, JSON.stringify(output, null, 2));
        
        if (!partial) {
            this.log(`Saved ${cards.length} cards to ${filepath}`, 'success');
            
            const partialPath = path.join(this.config.output.directory, 
                this.config.output.jsonFilename.replace('.json', '_partial.json'));
            try {
                await fs.unlink(partialPath);
            } catch (e) {}
        }
    }
    
    async saveIncremental() {
        if (this.cards.length > 0) {
            await this.saveJson(this.cards, true);
        }
    }
    
    printSummary() {
        this.log('=== SUMMARY ===', 'info');
        this.log(`Total: ${this.cards.length} cards`, 'info');
        
        const group = (attr) => {
            const counts = {};
            for (const c of this.cards) {
                const val = c[attr] || 'Unknown';
                counts[val] = (counts[val] || 0) + 1;
            }
            return counts;
        };
        
        this.log(`Sets: ${JSON.stringify(group('set'))}`, 'info');
        this.log(`Rarities: ${JSON.stringify(group('rarity'))}`, 'info');
        this.log(`Types: ${JSON.stringify(group('type'))}`, 'info');
    }
    
    async run() {
        const startTime = Date.now();
        
        try {
            await this.init();
            await this.navigateToCardBrowser();
            await this.applyFilters();
            
            const cardCount = await this.loadAllCards();
            
            if (cardCount === 0) {
                this.log('No cards to scrape!', 'error');
                return [];
            }
            
            const cardCodes = await this.scrapeCardCodes();
            
            const codesPath = path.join(this.config.output.directory, 'card_codes.json');
            await fs.mkdir(this.config.output.directory, { recursive: true });
            await fs.writeFile(codesPath, JSON.stringify({ 
                scraped_at: new Date().toISOString(),
                filters: this.config.filters,
                total: cardCodes.length,
                codes: cardCodes 
            }, null, 2));
            this.log(`Card codes saved to ${codesPath}`, 'success');
            
            this.log(`Scraping details for ${cardCodes.length} cards...`, 'info');
            
            if (this.config.scraping.includeCardDetails) {
                const SAVE_INTERVAL = 10;
                let imagesDownloaded = 0;
                
                for (let i = 0; i < cardCodes.length; i++) {
                    const card = await this.scrapeCardDetails(cardCodes[i]);
                    this.cards.push(card);
                    
                    if (this.config.output.downloadImages) {
                        const imgResult = await this.downloadImage(card);
                        if (imgResult) imagesDownloaded++;
                    }
                    
                    if ((i + 1) % 20 === 0 || i === cardCodes.length - 1) {
                        const imgStatus = this.config.output.downloadImages ? `, ${imagesDownloaded} images` : '';
                        this.log(`Progress: ${i + 1}/${cardCodes.length} cards${imgStatus}`, 'info');
                    }
                    
                    if ((i + 1) % SAVE_INTERVAL === 0) {
                        await this.saveIncremental();
                        this.log(`Progress saved (${this.cards.length} cards)`, 'debug');
                    }
                    
                    await this.sleep(this.config.scraping.delayBetweenCards);
                }
                
                if (this.config.output.downloadImages) {
                    this.log(`Images downloaded incrementally: ${imagesDownloaded}/${this.cards.length}`, 'success');
                }
            } else {
                this.cards = cardCodes.map(code => ({
                    code,
                    imageUrl: `https://fftcg.cdn.sewest.net/images/cards/full/${code}_eg.jpg`,
                }));
            }
            
            this.printSummary();
            
            if (this.config.output.saveJson) await this.saveJson(this.cards);
            
            if (this.config.output.downloadImages && !this.config.scraping.includeCardDetails) {
                await this.downloadImages(this.cards);
            }
            
            this.log(`Complete in ${((Date.now() - startTime) / 1000).toFixed(1)}s`, 'success');
            return this.cards;
            
        } catch (error) {
            this.log(`FATAL: ${error.message}`, 'error');
            console.error(error.stack);
            
            if (this.cards.length > 0) {
                this.log(`Attempting to save ${this.cards.length} cards before exit...`, 'warn');
                try {
                    await this.saveJson(this.cards, true);
                    this.log(`Emergency save complete: ${this.cards.length} cards saved to partial file`, 'success');
                } catch (saveError) {
                    this.log(`Could not save: ${saveError.message}`, 'error');
                }
            }
            
            throw error;
        } finally {
            await this.close();
        }
    }
}

// =============================================================================
// UTILITIES
// =============================================================================

async function setAlreadyScraped(folder, filename) {
    const filepath = path.join('./card_results', folder, filename);
    try {
        const content = await fs.readFile(filepath, 'utf8');
        const data = JSON.parse(content);
        if (data.complete && data.cards && data.cards.length > 0) {
            return { exists: true, count: data.cards.length };
        }
        return { exists: false };
    } catch (e) {
        return { exists: false };
    }
}

async function combineAllSets() {
    console.log('\n📦 Combining all sets into single JSON...');
    
    const allCards = [];
    const setStats = [];
    
    for (const setName of ALL_SETS) {
        const folder = setName.replace(/[^a-zA-Z0-9]/g, '');
        const filename = `${folder}_cards.json`;
        const filepath = path.join('./card_results', folder, filename);
        
        try {
            const content = await fs.readFile(filepath, 'utf8');
            const data = JSON.parse(content);
            
            if (data.cards && data.cards.length > 0) {
                allCards.push(...data.cards);
                setStats.push({ set: setName, count: data.cards.length });
                console.log(`  ✅ ${setName}: ${data.cards.length} cards`);
            }
        } catch (e) {
            console.log(`  ⚠️  ${setName}: not found or invalid`);
        }
    }
    
    if (allCards.length === 0) {
        console.log('❌ No cards found to combine');
        return null;
    }
    
    const combined = {
        scraped_at: new Date().toISOString(),
        total: allCards.length,
        sets: setStats,
        cards: allCards,
    };
    
    const outputPath = './card_results/all_cards_combined.json';
    await fs.writeFile(outputPath, JSON.stringify(combined, null, 2));
    console.log(`\n✅ Combined ${allCards.length} cards from ${setStats.length} sets`);
    console.log(`📄 Saved to: ${outputPath}`);
    
    return combined;
}

// =============================================================================
// CLI
// =============================================================================

async function main() {
    let config = {};
    
    const configIdx = process.argv.indexOf('--config');
    if (configIdx !== -1 && process.argv[configIdx + 1]) {
        try {
            config = JSON.parse(await fs.readFile(process.argv[configIdx + 1], 'utf8'));
            console.log(`📄 Loaded config: ${process.argv[configIdx + 1]}`);
        } catch (e) {
            console.error(`❌ Config error: ${e.message}`);
            process.exit(1);
        }
    }
    
    // --combine flag: just combine existing JSONs without scraping
    if (process.argv.includes('--combine')) {
        await combineAllSets();
        return;
    }
    
    // --all flag: scrape every set sequentially
    if (process.argv.includes('--all')) {
        const downloadImages = process.argv.includes('--images');
        const headless = !process.argv.includes('--visible');
        const force = process.argv.includes('--force');
        const startFrom = process.argv.find(a => a.startsWith('--start='))?.split('=')[1];
        
        let setsToScrape = [...ALL_SETS];
        if (startFrom) {
            const idx = ALL_SETS.findIndex(s => s.toLowerCase().includes(startFrom.toLowerCase()));
            if (idx !== -1) {
                setsToScrape = ALL_SETS.slice(idx);
                console.log(`⏭️  Starting from "${ALL_SETS[idx]}" (${setsToScrape.length} sets)`);
            }
        }
        
        console.log(`\n🎴 FFTCG Scraper - Scraping ALL sets`);
        console.log(`📦 Sets: ${setsToScrape.length}`);
        console.log(`🖼️  Images: ${downloadImages}`);
        console.log(`👁️  Headless: ${headless}`);
        console.log(`🔄 Force re-scrape: ${force}\n`);
        
        const results = [];
        const skipped = [];
        const startTime = Date.now();
        
        for (let i = 0; i < setsToScrape.length; i++) {
            const setName = setsToScrape[i];
            const folder = setName.replace(/[^a-zA-Z0-9]/g, '');
            const filename = `${folder}_cards.json`;
            
            // Check if already scraped (unless --force)
            if (!force) {
                const existing = await setAlreadyScraped(folder, filename);
                if (existing.exists) {
                    console.log(`⏭️  [${i + 1}/${setsToScrape.length}] ${setName}: already scraped (${existing.count} cards)`);
                    skipped.push({ set: setName, count: existing.count });
                    results.push({ set: setName, count: existing.count, status: 'skipped' });
                    continue;
                }
            }
            
            console.log(`\n${'='.repeat(50)}`);
            console.log(`[${i + 1}/${setsToScrape.length}] ${setName}`);
            console.log(`${'='.repeat(50)}`);
            
            const setConfig = {
                output: {
                    directory: `./card_results/${folder}`,
                    downloadImages,
                    saveJson: true,
                    jsonFilename: filename,
                },
                filters: { sets: [setName] },
                scraping: { includeCardDetails: true, headless },
            };
            
            try {
                const scraper = new FFTCGScraper(setConfig);
                const cards = await scraper.run();
                results.push({ set: setName, count: cards.length, status: 'scraped' });
                console.log(`\n✅ ${setName}: ${cards.length} cards\n`);
            } catch (err) {
                console.error(`\n❌ ${setName} failed: ${err.message}\n`);
                results.push({ set: setName, count: 0, status: 'failed', error: err.message });
            }
            
            if (i < setsToScrape.length - 1) {
                console.log('⏳ Waiting 2s before next set...');
                await new Promise(r => setTimeout(r, 2000));
            }
        }
        
        // Summary
        const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
        const scraped = results.filter(r => r.status === 'scraped');
        const failed = results.filter(r => r.status === 'failed');
        const total = results.reduce((s, r) => s + r.count, 0);
        
        console.log(`\n${'='.repeat(50)}`);
        console.log(`✅ COMPLETE`);
        console.log(`${'='.repeat(50)}`);
        console.log(`⏱️  Time: ${elapsed} minutes`);
        console.log(`🎴 Total: ${total} cards`);
        console.log(`✅ Scraped: ${scraped.length} sets`);
        console.log(`⏭️  Skipped: ${skipped.length} sets (already existed)`);
        console.log(`❌ Failed: ${failed.length} sets`);
        
        if (failed.length) {
            console.log(`\nFailed sets:`);
            failed.forEach(f => console.log(`  - ${f.set}: ${f.error}`));
        }
        
        // Save summary
        await fs.mkdir('./card_results', { recursive: true });
        await fs.writeFile('./card_results/batch_summary.json', JSON.stringify({
            scraped_at: new Date().toISOString(),
            elapsed_minutes: parseFloat(elapsed),
            total_cards: total,
            results,
        }, null, 2));
        
        // Combine all sets into single JSON
        await combineAllSets();
        
        return;
    }
    
    // CLI overrides for single-set mode
    if (process.argv.includes('--no-images')) config.output = { ...config.output, downloadImages: false };
    if (process.argv.includes('--images')) config.output = { ...config.output, downloadImages: true };
    if (process.argv.includes('--no-details')) config.scraping = { ...config.scraping, includeCardDetails: false };
    if (process.argv.includes('--visible')) config.scraping = { ...config.scraping, headless: false };
    
    const setIdx = process.argv.indexOf('--set');
    if (setIdx !== -1 && process.argv[setIdx + 1]) {
        config.filters = { ...config.filters, sets: [process.argv[setIdx + 1]] };
    }
    
    const rarityIdx = process.argv.indexOf('--rarity');
    if (rarityIdx !== -1 && process.argv[rarityIdx + 1]) {
        config.filters = { ...config.filters, rarities: [process.argv[rarityIdx + 1]] };
    }
    
    const catIdx = process.argv.indexOf('--category');
    if (catIdx !== -1 && process.argv[catIdx + 1]) {
        config.filters = { ...config.filters, categories: [process.argv[catIdx + 1]] };
    }
    
    const scraper = new FFTCGScraper(config);
    await scraper.run();
}

module.exports = { FFTCGScraper, DEFAULT_CONFIG, FILTER_SELECTORS, ALL_SETS, combineAllSets };

if (require.main === module) {
    main().catch(err => {
        console.error(`❌ Fatal: ${err.message}`);
        process.exit(1);
    });
}
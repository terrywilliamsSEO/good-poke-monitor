require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');

class PageMonitor {
    constructor() {
        this.pages = [
            'https://store.401games.ca/collections/all-pokemon-pre-orders',
            'https://deckoutgaming.ca/collections/pokemon-sealed-pre-orders'
        ];
        this.pageHashes = new Map();
        this.discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
        this.intervalMs = 10000; // 10 seconds
        
        if (!this.discordWebhookUrl) {
            console.error('DISCORD_WEBHOOK_URL environment variable is required');
            process.exit(1);
        }
    }

    async scrapePageContent(url) {
        try {
            console.log(`Scraping: ${url}`);
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                },
                timeout: 30000
            });

            const $ = cheerio.load(response.data);
            
            // Remove dynamic elements that change frequently
            $('script, style, noscript, .timestamp, .session-id, [id*="timestamp"], [class*="timestamp"]').remove();
            
            // Extract relevant content based on the site
            let products = [];
            let content = '';
            
            if (url.includes('401games.ca')) {
                // Extract product listings from 401games - more specific selectors
                $('.product-item, .grid-item, .product-card').each((i, elem) => {
                    const $elem = $(elem);
                    const title = $elem.find('.product-item__title, .product-title, h2, h3, .card-title, a[href*="products"]').first().text().trim();
                    const price = $elem.find('.price, .money, .product-price, .cost').first().text().trim();
                    const availability = $elem.find('.product-item__inventory, .inventory, .stock, .badge, .btn').first().text().trim();
                    const productLink = $elem.find('a[href*="products"]').first().attr('href');
                    
                    if (title && title.length > 3) {
                        const normalizedTitle = title.replace(/\s+/g, ' ').toLowerCase();
                        const normalizedPrice = price.replace(/\s+/g, '');
                        const normalizedAvailability = availability.replace(/\s+/g, ' ').toLowerCase();
                        const fullLink = productLink && !productLink.startsWith('http') ? `https://store.401games.ca${productLink}` : productLink;
                        
                        products.push({
                            title: title,
                            price: price,
                            availability: availability,
                            link: fullLink
                        });
                        content += `${normalizedTitle}|${normalizedPrice}|${normalizedAvailability}\n`;
                    }
                });
            } else if (url.includes('deckoutgaming.ca')) {
                // Extract product listings from deckoutgaming - more specific selectors
                $('.product-item, .product-card, .grid__item, .product-wrap').each((i, elem) => {
                    const $elem = $(elem);
                    const title = $elem.find('.card__heading, .product-title, h2, h3, .card-title, a[href*="products"]').first().text().trim();
                    const price = $elem.find('.price, .money, .product-price, .cost').first().text().trim();
                    const availability = $elem.find('.badge, .product-form__cart-submit, .btn, .stock, .inventory').first().text().trim();
                    const productLink = $elem.find('a[href*="products"]').first().attr('href');
                    
                    if (title && title.length > 3) {
                        const normalizedTitle = title.replace(/\s+/g, ' ').toLowerCase();
                        const normalizedPrice = price.replace(/\s+/g, '');
                        const normalizedAvailability = availability.replace(/\s+/g, ' ').toLowerCase();
                        const fullLink = productLink && !productLink.startsWith('http') ? `https://deckoutgaming.ca${productLink}` : productLink;
                        
                        products.push({
                            title: title,
                            price: price,
                            availability: availability,
                            link: fullLink
                        });
                        content += `${normalizedTitle}|${normalizedPrice}|${normalizedAvailability}\n`;
                    }
                });
            }

            // If no specific products found, try alternative selectors
            if (!content) {
                $('[href*="products"], .product, .item').each((i, elem) => {
                    const $elem = $(elem);
                    const text = $elem.text().trim();
                    if (text && text.length > 10 && (text.toLowerCase().includes('pokemon') || text.toLowerCase().includes('tcg'))) {
                        content += text.replace(/\s+/g, ' ').toLowerCase() + '\n';
                    }
                });
            }

            // Sort content lines to reduce false positives from reordering
            if (content) {
                const lines = content.split('\n').filter(line => line.trim()).sort();
                content = lines.join('\n');
            }

            return { content, products };
        } catch (error) {
            console.error(`Error scraping ${url}:`, error.message);
            return null;
        }
    }

    generateHash(content) {
        return crypto.createHash('md5').update(content).digest('hex');
    }

    async sendDiscordNotification(url, currentProducts, previousProducts) {
        try {
            const websiteName = url.includes('401games.ca') ? '401 Games' : 'Deck Out Gaming';
            
            // Find new or changed products
            const newProducts = this.findNewProducts(currentProducts, previousProducts);
            
            const embed = {
                title: '🚨 Pokemon Product Alert!',
                description: `${newProducts.length} change(s) detected on ${websiteName}`,
                color: 0x00ff00,
                fields: [
                    {
                        name: 'Website',
                        value: websiteName,
                        inline: true
                    },
                    {
                        name: 'Timestamp',
                        value: new Date().toISOString(),
                        inline: true
                    }
                ],
                footer: {
                    text: 'Pokemon Pre-order Monitor'
                }
            };

            // Add product details (limit to first 5 to avoid message limits)
            const productsToShow = newProducts.slice(0, 5);
            productsToShow.forEach((product, index) => {
                const fieldName = `🎯 Product ${index + 1}`;
                let fieldValue = `**${product.title}**\n`;
                if (product.price) fieldValue += `💰 ${product.price}\n`;
                if (product.availability) fieldValue += `📦 ${product.availability}\n`;
                if (product.link) fieldValue += `🔗 [View Product](${product.link})`;
                
                embed.fields.push({
                    name: fieldName,
                    value: fieldValue,
                    inline: false
                });
            });

            if (newProducts.length > 5) {
                embed.fields.push({
                    name: '📝 Note',
                    value: `+ ${newProducts.length - 5} more changes detected`,
                    inline: false
                });
            }

            await axios.post(this.discordWebhookUrl, {
                embeds: [embed]
            });

            console.log(`Discord notification sent for ${url} with ${newProducts.length} product(s)`);
        } catch (error) {
            console.error('Error sending Discord notification:', error.message);
        }
    }

    findNewProducts(currentProducts, previousProducts) {
        if (!previousProducts || previousProducts.length === 0) {
            return []; // Don't alert on initial scan
        }
        
        const previousTitles = new Set(previousProducts.map(p => p.title.toLowerCase()));
        return currentProducts.filter(product => 
            !previousTitles.has(product.title.toLowerCase())
        );
    }

    async checkPage(url) {
        const result = await this.scrapePageContent(url);
        if (!result) {
            return;
        }

        const { content, products } = result;
        const currentHash = this.generateHash(content);
        const previousData = this.pageHashes.get(url);
        const previousHash = previousData?.hash;
        const previousProducts = previousData?.products || [];

        if (previousHash && previousHash !== currentHash) {
            console.log(`Change detected on ${url}`);
            await this.sendDiscordNotification(url, products, previousProducts);
        } else if (!previousHash) {
            console.log(`Initial scan completed for ${url}`);
        } else {
            console.log(`No changes detected on ${url}`);
        }

        this.pageHashes.set(url, { hash: currentHash, products });
    }

    async monitorPages() {
        console.log('Starting Pokemon pre-order monitor...');
        console.log(`Monitoring ${this.pages.length} pages every ${this.intervalMs/1000} seconds`);
        
        // Initial scan
        for (const url of this.pages) {
            await this.checkPage(url);
            // Small delay between initial scans
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        // Set up interval monitoring
        setInterval(async () => {
            for (const url of this.pages) {
                await this.checkPage(url);
                // Small delay between page checks to be respectful
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }, this.intervalMs);
    }

    start() {
        console.log('Pokemon Pre-order Monitor Service Starting...');
        this.monitorPages().catch(error => {
            console.error('Fatal error in monitor:', error);
            process.exit(1);
        });
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down monitor...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\nShutting down monitor...');
    process.exit(0);
});

// Start the monitor
const monitor = new PageMonitor();
monitor.start();
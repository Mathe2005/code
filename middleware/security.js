
const rateLimit = require('express-rate-limit');
const slowDown = require('express-slow-down');
const securityLogger = require('../utils/securityLogger');

// In-memory store for tracking suspicious activity
const suspiciousIPs = new Map();
const failedAttempts = new Map();
const blockedIPs = new Set();

// Whitelist for trusted IPs (add your own IPs here)
const trustedIPs = new Set([
    '127.0.0.1',
    '::1'  // Your IP address
]);

// Clean up old entries every 30 minutes
setInterval(() => {
    const now = Date.now();
    const thirtyMinutes = 30 * 60 * 1000;
    
    for (const [ip, data] of suspiciousIPs.entries()) {
        if (now - data.lastSeen > thirtyMinutes) {
            suspiciousIPs.delete(ip);
        }
    }
    
    for (const [ip, data] of failedAttempts.entries()) {
        if (now - data.lastAttempt > thirtyMinutes) {
            failedAttempts.delete(ip);
        }
    }
}, 30 * 60 * 1000);

// Get real IP address
function getRealIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.headers['x-real-ip'] ||
           req.connection.remoteAddress ||
           req.socket.remoteAddress ||
           req.ip;
}

// Check if IP is suspicious
function isSuspiciousActivity(req) {
    const ip = getRealIP(req);
    const userAgent = req.headers['user-agent'] || '';
    const path = req.path;
    
    // Check for common bot patterns
    const botPatterns = [
        /bot/i,
        /crawler/i,
        /spider/i,
        /scraper/i,
        /curl/i,
        /wget/i,
        /python/i,
        /java/i,
        /perl/i,
        /php/i,
        /scanner/i,
        /nikto/i,
        /sqlmap/i,
        /masscan/i,
        /nmap/i
    ];
    
    // Check for suspicious paths
    const suspiciousPaths = [
        /\/admin/i,
        /\/wp-admin/i,
        /\/phpmyadmin/i,
        /\.php$/i,
        /\.asp$/i,
        /\.jsp$/i,
        /\/cgi-bin/i,
        /\/config/i,
        /\/backup/i,
        /\/database/i,
        /\/sql/i,
        /\/shell/i,
        /\/cmd/i,
        /\/exec/i,
        /\/eval/i,
        /\/upload/i,
        /\/download/i,
        /\/\.env/i,
        /\/\.git/i,
        /\/\.svn/i,
        /\/node_modules/i
    ];
    
    // Check for injection attempts
    const injectionPatterns = [
        /[<>'"]/,
        /javascript:/i,
        /vbscript:/i,
        /onload=/i,
        /onclick=/i,
        /onerror=/i,
        /union.*select/i,
        /drop.*table/i,
        /insert.*into/i,
        /delete.*from/i,
        /update.*set/i,
        /exec.*\(/i,
        /system\(/i,
        /shell_exec/i,
        /passthru/i,
        /file_get_contents/i,
        /base64_decode/i,
        /\.\.\//,
        /\/etc\/passwd/i,
        /\/proc\/version/i,
        /cmd\.exe/i,
        /powershell/i
    ];
    
    let suspicionScore = 0;
    let reasons = [];
    
    // Check user agent - be less strict for normal browsers
    if (!userAgent || userAgent.length < 5) {
        suspicionScore += 20;
        reasons.push('Suspicious or missing user agent');
    } else {
        // Only flag obvious bots, not legitimate tools
        for (const pattern of botPatterns) {
            if (pattern.test(userAgent) && !userAgent.includes('Mozilla') && !userAgent.includes('Chrome') && !userAgent.includes('Safari')) {
                suspicionScore += 30;
                reasons.push('Bot-like user agent');
                break;
            }
        }
    }
    
    // Check path
    for (const pattern of suspiciousPaths) {
        if (pattern.test(path)) {
            suspicionScore += 40;
            reasons.push('Suspicious path access');
            break;
        }
    }
    
    // Check for injection attempts in query params and body
    const queryString = req.url.split('?')[1] || '';
    const bodyString = JSON.stringify(req.body || {});
    
    for (const pattern of injectionPatterns) {
        if (pattern.test(queryString) || pattern.test(bodyString)) {
            suspicionScore += 50;
            reasons.push('Potential injection attempt');
            break;
        }
    }
    
    // Check for rapid requests - be more lenient for normal browsing
    const now = Date.now();
    const ipData = suspiciousIPs.get(ip) || { count: 0, firstSeen: now, lastSeen: now, rapidCount: 0 };
    
    if (now - ipData.lastSeen < 500) { // Less than 500ms between requests
        ipData.rapidCount = (ipData.rapidCount || 0) + 1;
        // Only flag as suspicious if many rapid requests in sequence
        if (ipData.rapidCount > 5) {
            suspicionScore += 15;
            reasons.push('Excessive rapid requests');
        }
    } else {
        // Reset rapid count if enough time has passed
        ipData.rapidCount = 0;
    }
    
    ipData.count++;
    ipData.lastSeen = now;
    suspiciousIPs.set(ip, ipData);
    
    return { isSuspicious: suspicionScore > 60, score: suspicionScore, reasons };
}

// Block suspicious IPs temporarily
function blockSuspiciousIP(ip, duration = 15 * 60 * 1000) { // 15 minutes default
    blockedIPs.add(ip);
    console.log(`🔒 Blocked suspicious IP: ${ip}`);
    
    setTimeout(() => {
        blockedIPs.delete(ip);
        console.log(`🔓 Unblocked IP: ${ip}`);
    }, duration);
}

// Advanced rate limiter for different endpoints
const createAdvancedRateLimit = (options = {}) => {
    const defaults = {
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 100,
        trustProxy: 1,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req, res) => {
            const ip = getRealIP(req);
            console.log(`⚠️ Rate limit exceeded for IP: ${ip}`);
            
            // Track failed attempts
            const attempts = failedAttempts.get(ip) || { count: 0, lastAttempt: Date.now() };
            attempts.count++;
            attempts.lastAttempt = Date.now();
            failedAttempts.set(ip, attempts);
            
            // Block IP if too many rate limit violations
            if (attempts.count >= 5) {
                blockSuspiciousIP(ip, 30 * 60 * 1000); // 30 minutes
            }
            
            res.status(429).json({
                error: 'Too many requests',
                message: 'Please slow down your requests',
                retryAfter: Math.ceil(options.windowMs / 1000)
            });
        },
        skip: (req) => {
            const ip = getRealIP(req);
            return trustedIPs.has(ip);
        }
    };
    
    return rateLimit({ ...defaults, ...options });
};

// Speed limiter for gradual slowdown
const createSpeedLimiter = (options = {}) => {
    const defaults = {
        windowMs: 15 * 60 * 1000,
        delayAfter: 50,
        delayMs: () => 500, // Updated to new v2 syntax
        maxDelayMs: 20000,
        trustProxy: 1,
        skip: (req) => {
            const ip = getRealIP(req);
            return trustedIPs.has(ip);
        }
    };
    
    return slowDown({ ...defaults, ...options });
};

// Main security middleware
function createSecurityStack() {
    return [
        // IP blocking middleware
        (req, res, next) => {
            const ip = getRealIP(req);
            
            if (blockedIPs.has(ip)) {
                console.log(`🚫 Blocked IP attempted access: ${ip}`);
                return res.status(403).json({
                    error: 'Access denied',
                    message: 'Your IP has been temporarily blocked due to suspicious activity'
                });
            }
            
            next();
        },
        
        // Suspicious activity detection
        (req, res, next) => {
            const ip = getRealIP(req);
            
            // Skip detection for trusted IPs
            if (trustedIPs.has(ip)) {
                return next();
            }
            
            const analysis = isSuspiciousActivity(req);
            
            if (analysis.isSuspicious) {
                const details = {
                    ip,
                    userAgent: req.headers['user-agent'],
                    path: req.path,
                    method: req.method,
                    score: analysis.score,
                    reasons: analysis.reasons,
                    body: req.body,
                    query: req.query
                };

                // Only block for very high scores (100+) and actual malicious patterns
                if (analysis.score > 100) {
                    securityLogger.critical('High-risk activity blocked', details);
                    blockSuspiciousIP(ip, 30 * 60 * 1000); // 30 minutes instead of 1 hour
                    return res.status(403).json({
                        error: 'Access denied',
                        message: 'Suspicious activity detected'
                    });
                } else if (analysis.score > 50) {
                    securityLogger.warn('Suspicious activity detected', details);
                    // Log but don't block for moderate scores
                }
            }
            
            next();
        },
        
        // General rate limiting
        createAdvancedRateLimit({
            windowMs: 15 * 60 * 1000, // 15 minutes
            max: 200, // Increased for normal users
            message: {
                error: 'Too many requests',
                message: 'Please wait before making more requests'
            }
        }),
        
        // Speed limiting for gradual slowdown
        createSpeedLimiter({
            windowMs: 15 * 60 * 1000,
            delayAfter: 100,
            delayMs: () => 200 // Updated to new v2 syntax
        }),
        
        // Pre-created rate limiters for different endpoints
        createAdvancedRateLimit({
            windowMs: 5 * 60 * 1000, // 5 minutes
            max: 100,
            message: {
                error: 'API rate limit exceeded',
                message: 'Too many API requests, please slow down'
            },
            skip: (req) => {
                const ip = getRealIP(req);
                return trustedIPs.has(ip) || !req.path.startsWith('/api/');
            }
        }),
        
        // Authentication endpoint protection
        createAdvancedRateLimit({
            windowMs: 15 * 60 * 1000,
            max: 10, // Very strict for auth endpoints
            message: {
                error: 'Authentication rate limit exceeded',
                message: 'Too many authentication attempts'
            },
            skip: (req) => {
                const ip = getRealIP(req);
                return trustedIPs.has(ip) || !req.path.startsWith('/auth/');
            }
        })
    ];
}

// Security headers middleware
function securityHeaders(req, res, next) {
    // Prevent clickjacking
    res.setHeader('X-Frame-Options', 'DENY');
    
    // Prevent MIME type sniffing
    res.setHeader('X-Content-Type-Options', 'nosniff');
    
    // XSS Protection
    res.setHeader('X-XSS-Protection', '1; mode=block');
    
    // Referrer Policy
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    
    // Permissions Policy
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    
    next();
}

// Request validation middleware
function validateRequest(req, res, next) {
    const ip = getRealIP(req);
    
    // Check for overly large requests
    if (req.headers['content-length'] && parseInt(req.headers['content-length']) > 10 * 1024 * 1024) { // 10MB limit
        console.log(`⚠️ Large request blocked from ${ip}: ${req.headers['content-length']} bytes`);
        return res.status(413).json({
            error: 'Request too large',
            message: 'Request size exceeds maximum allowed limit'
        });
    }
    
    // Check for suspicious headers
    const suspiciousHeaders = ['x-cluster-client-ip', 'x-forwarded', 'forwarded-for', 'x-remote-ip', 'x-originating-ip'];
    for (const header of suspiciousHeaders) {
        if (req.headers[header] && req.headers[header] !== getRealIP(req)) {
            console.log(`⚠️ Suspicious header detected from ${ip}: ${header}`);
        }
    }
    
    next();
}

module.exports = {
    createSecurityStack,
    createAdvancedRateLimit,
    createSpeedLimiter,
    securityHeaders,
    validateRequest,
    getRealIP,
    trustedIPs,
    blockedIPs
};

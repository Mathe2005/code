const express = require('express');
const session = require('express-session');
const passport = require('passport');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const slowDown = require('express-slow-down');
require('dotenv').config();

// Import configurations and services
const client = require('./config/discord');
const { initializeDatabase } = require('./config/database');

// Import middleware
const { ensureAuthenticated } = require('./middleware/auth');

// Import routes
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const { router: apiRoutes, setWebSocketServer } = require('./routes/api');

// Import event handlers
const setupDiscordEvents = require('./events/discordEvents');

// Express setup
const app = express();
const PORT = process.env.PORT || 5000;

// Create HTTP server
const server = require('http').createServer(app);

// WebSocket setup - integrate with Express server
const wss = new WebSocket.Server({ server });

// Set WebSocket server for API routes
setWebSocketServer(wss);

// Middleware
app.set('trust proxy', 1); // Trust only first proxy

// Configure Express to handle X-Forwarded-* headers properly
app.use((req, res, next) => {
    // Force protocol detection from headers if behind proxy
    if (req.headers['x-forwarded-proto']) {
        req.protocol = req.headers['x-forwarded-proto'];
    }
    next();
});

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: [
                "'self'",
                "'unsafe-inline'",
                "https://cdn.jsdelivr.net",
                "https://cdnjs.cloudflare.com"
            ],
            scriptSrc: [
                "'self'",
                "'unsafe-inline'",
                "https://cdn.jsdelivr.net"
            ],
            scriptSrcAttr: ["'unsafe-inline'"],
            fontSrc: [
                "'self'",
                "https://cdnjs.cloudflare.com"
            ],
            imgSrc: [
                "'self'",
                "data:",
                "https://cdn.discordapp.com",
                "https://i.ytimg.com",
                "https://img.youtube.com"
            ],
            connectSrc: [
                "'self'",
                "http:",
                "https:",
                "ws:",
                "wss:"
            ],
            upgradeInsecureRequests: null // Disable upgrade for HTTP deployment
        }
    },
    crossOriginOpenerPolicy: false,
    originAgentCluster: false,
    hsts: false // Disable HSTS for HTTP deployment
}));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));
app.set('view engine', 'ejs');

// Enhanced security middleware
const securityMiddleware = require('./middleware/security');
app.use(securityMiddleware.createSecurityStack());

// Add security headers and request validation
const { securityHeaders, validateRequest } = require('./middleware/security');
app.use(securityHeaders);
app.use(validateRequest);

// Add middleware for HTTP deployment compatibility
app.use((req, res, next) => {
    // Remove any HTTPS upgrade headers for HTTP deployment
    res.removeHeader('Strict-Transport-Security');

    // Set proper protocol for HTTP deployment
    req.protocol = 'http';
    if (req.headers['x-forwarded-proto']) {
        req.headers['x-forwarded-proto'] = 'http';
    }

    next();
});

// Session configuration
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // Set to false for HTTP connections
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000,
        sameSite: 'lax'
    }
}));

app.use(passport.initialize());
app.use(passport.session());

// Middleware to track last visited page for authenticated users
app.use((req, res, next) => {
    if (req.isAuthenticated() && req.method === 'GET' &&
        req.path.startsWith('/dashboard/') &&
        !req.path.includes('/api/') &&
        !req.xhr) {
        req.session.lastPage = req.originalUrl;
    }
    next();
});

// Routes
app.get('/', (req, res) => {
    res.render('index', { user: req.user });
});

app.get('/logout', (req, res) => {
    // Store current page before logout
    const currentPage = req.get('Referer');
    if (currentPage && currentPage.includes('/dashboard/')) {
        req.session.lastPage = currentPage.split(req.get('Host'))[1] || '/dashboard';
    }

    req.logout((err) => {
        if (err) return next(err);
        res.redirect('/');
    });
});

// Security monitoring endpoint (admin only)
app.get('/security/logs', ensureAuthenticated, async (req, res) => {
    // Check if user has admin permissions in any guild
    const hasAdminAccess = req.user.guilds?.some(guild => {
        const permissions = parseInt(guild.permissions);
        return (permissions & 0x8) === 0x8; // Administrator permission
    });

    if (!hasAdminAccess) {
        return res.status(403).json({ error: 'Admin access required' });
    }

    try {
        const securityLogger = require('./utils/securityLogger');
        const logs = await securityLogger.getRecentLogs(24);
        res.json({ logs });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch security logs' });
    }
});

// Mount route modules
app.use('/auth', authRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/api', apiRoutes);

// WebSocket connection
wss.on('connection', (ws, req) => {
    const clientIP = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    console.log(`WebSocket client connected from ${clientIP}`);

    // Set up ping interval for this connection
    const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
        } else {
            clearInterval(pingInterval);
        }
    }, 30000); // Ping every 30 seconds

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'subscribe' && data.guildId) {
                ws.guildId = data.guildId;
                console.log(`WebSocket subscribed to guild: ${data.guildId}`);
            }

            if (data.type === 'ping') {
                // Respond to ping with pong
                ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            }
        } catch (error) {
            console.error('Error parsing WebSocket message:', error);
        }
    });

    ws.on('pong', () => {
        // Client responded to our ping
        ws.isAlive = true;
    });

    ws.on('close', (code, reason) => {
        // Only log disconnects for unexpected closures
        if (code !== 1000 && code !== 1001) {
            console.log(`WebSocket client disconnected (code: ${code}, reason: ${reason})`);
        }
        clearInterval(pingInterval);
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        clearInterval(pingInterval);
    });

    // Set initial alive status
    ws.isAlive = true;
});

// Clean up dead connections every minute
setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) {
            console.log('Terminating dead WebSocket connection');
            return ws.terminate();
        }

        ws.isAlive = false;
        ws.ping();
    });
}, 60000);

// Global error handlers for anti-crash protection
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    console.error('Stack:', error.stack);
    // Don't exit the process, just log the error
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Don't exit the process, just log the error
});

// Discord client error handlers
client.on('error', (error) => {
    console.error('Discord client error:', error);
});

client.on('warn', (warning) => {
    console.warn('Discord client warning:', warning);
});

client.on('disconnect', () => {
    console.log('Discord client disconnected. Attempting to reconnect...');
});

client.on('reconnecting', () => {
    console.log('Discord client reconnecting...');
});

client.on('resume', (replayed) => {
    console.log(`Discord client resumed. Replayed ${replayed} events.`);
});

// Express error handler
app.use((error, req, res, next) => {
    console.error('Express error:', error);
    if (res.headersSent) {
        return next(error);
    }
    res.status(500).render('error', {
        message: 'Internal Server Error',
        error: 'Something went wrong. Please try again later.'
    });
});

// Initialize and start servers
async function startApplication() {
    try {
        await initializeDatabase();

        // Setup Discord event handlers
        setupDiscordEvents(client, wss);

        server.listen(PORT, '0.0.0.0', () => {
            console.log(`Server running on http://0.0.0.0:${PORT}`);
            console.log(`Access via: http://104.248.32.109:${PORT}`);
            console.log(`WebSocket server integrated on same port`);
        });

        await client.login(process.env.DISCORD_TOKEN);
        console.log('Bot logged in successfully');
    } catch (error) {
        console.error('Failed to start application:', error);
        // Retry after 5 seconds
        setTimeout(() => {
            console.log('Retrying application start...');
            startApplication();
        }, 5000);
    }
}

// Auto-restart mechanism for Discord client
client.on('shardError', (error) => {
    console.error('Shard error:', error);
});

client.on('shardDisconnect', (event, id) => {
    console.log(`Shard ${id} disconnected with code ${event.code}.`);
});

client.on('shardReconnecting', (id) => {
    console.log(`Shard ${id} is reconnecting...`);
});

client.once('ready', () => {
    console.log(`Bot is ready! Logged in as ${client.user.tag}`);
});

// Handle button interactions for approval system
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    // Check if this is an approval system interaction
    const customId = interaction.customId;
    if (customId.startsWith('approve_') || customId.startsWith('decline_')) {
        const { handleApprovalInteraction } = require('./utils/approvalSystem');
        await handleApprovalInteraction(interaction);
    }
});

startApplication();
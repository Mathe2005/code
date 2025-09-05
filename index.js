const express = require('express');
const session = require('express-session');
const passport = require('passport');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
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
                "https:",
                "wss:"
            ]
        }
    },
    crossOriginOpenerPolicy: false,
    originAgentCluster: false
}));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));
app.set('view engine', 'ejs');

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    trustProxy: 1 // Trust only first proxy for rate limiting
});
app.use(limiter);

// Add middleware to handle HTTP-only requests and prevent HTTPS redirects
app.use((req, res, next) => {
    // Remove any HTTPS upgrade headers
    res.removeHeader('Strict-Transport-Security');
    
    // Ensure we're working with HTTP protocol
    if (req.headers['x-forwarded-proto'] === 'https') {
        req.protocol = 'http';
        req.headers['x-forwarded-proto'] = 'http';
    }
    
    // Set headers to prevent HTTPS redirects
    res.setHeader('Content-Security-Policy', "upgrade-insecure-requests; block-all-mixed-content;".replace('upgrade-insecure-requests; ', ''));
    
    next();
});

// Session configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key',
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

// Mount route modules
app.use('/auth', authRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/api', apiRoutes);

// WebSocket connection
wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        const data = JSON.parse(message);
        if (data.type === 'subscribe' && data.guildId) {
            ws.guildId = data.guildId;
        }
    });
});

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

startApplication();
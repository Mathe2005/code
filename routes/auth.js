
const express = require('express');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const router = express.Router();

// Passport configuration
passport.use(new DiscordStrategy({
    clientID: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackURL: process.env.DISCORD_CALLBACK_URL,
    scope: ['identify', 'guilds'],
    passReqToCallback: false
}, (accessToken, refreshToken, profile, done) => {
    return done(null, profile);
}));

passport.serializeUser((user, done) => {
    done(null, user);
});

passport.deserializeUser((obj, done) => {
    done(null, obj);
});

// Routes
router.get('/discord', (req, res, next) => {
    passport.authenticate('discord')(req, res, next);
});

router.get('/discord/callback', (req, res, next) => {
    
    passport.authenticate('discord', { 
        failureRedirect: '/',
        failureFlash: false
    })(req, res, (err) => {
        if (err) {
            return res.redirect('/?error=auth_failed');
        }
        
        const lastPage = req.session.lastPage || '/dashboard';
        delete req.session.lastPage;
        res.redirect(lastPage);
    });
});

// Add error handling route
router.get('/error', (req, res) => {
    res.render('error', {
        message: 'Authentication Error',
        error: 'There was an issue with Discord authentication. Please try again.'
    });
});

module.exports = router;

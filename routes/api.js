const express = require('express');
const router = express.Router();
const { ensureRole, ensureDjOrAdmin, ensureAuthenticated } = require('../middleware/auth');
const { getOrCreateGuildConfig, updateMemberNickname } = require('../utils/guildUtils');
const { AuditLog, logAction, trackDashboardAction } = require('../utils/auditLogger');
const { getMusicQueue, broadcastMusicUpdate, manager, playNextSong } = require('../services/musicService');
const { Sequelize, Op } = require('sequelize');
const client = require('../config/discord');

// Add this at the top after the imports
let wss;

function setWebSocketServer(webSocketServer) {
    wss = webSocketServer;
}

// Force music state update for page loads/refreshes
router.get('/dashboard/:guildId/music/status', ensureAuthenticated, async (req, res) => {
    const guildId = req.params.guildId;

    try {
        const { getMusicQueue, getPlayerForGuild, broadcastMusicUpdate } = require('../services/musicService');
        const musicQueue = getMusicQueue(guildId);
        const player = getPlayerForGuild(guildId);

        // Force update the current song if player has one but queue doesn't
        if (player && player.queue && player.queue.current && !musicQueue.currentSong) {
            const track = player.queue.current;
            musicQueue.currentSong = {
                title: track.info.title,
                url: track.info.uri,
                duration: track.info.length || track.info.duration || 0,
                addedBy: track.info.requester || 'Unknown',
                thumbnail: track.info.artworkUrl || track.info.thumbnail || null
            };
            musicQueue.isPlaying = !player.paused;
        }

        // Broadcast current state to ensure UI is in sync
        broadcastMusicUpdate(guildId, musicQueue, wss, 'force_update');

        res.json({
            isPlaying: musicQueue.isPlaying,
            currentSong: musicQueue.currentSong,
            queue: musicQueue.queue,
            currentPosition: player ? player.position : 0,
            volume: player ? player.volume : 50,
            isPaused: player ? player.paused : false
        });
    } catch (error) {
        console.error('Error getting music status:', error);
        res.status(500).json({ error: 'Failed to get music status' });
    }
});

// Music control endpoints
router.post('/dashboard/:guildId/music/play', ensureDjOrAdmin, async (req, res) => {
    const { guildId } = req.params;
    let { url, channelId } = req.body;

    console.log(`Received music play request: URL="${url}", ChannelId="${channelId}"`);

    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            return res.status(404).json({ error: 'Guild not found' });
        }

        const channel = guild.channels.cache.get(channelId);
        if (!channel || channel.type !== 2) {
            return res.status(400).json({ error: 'Invalid voice channel selected' });
        }

        if (!url || !url.trim()) {
            return res.status(400).json({ error: 'URL or search term is required' });
        }

        url = url.trim();

        const managerInstance = manager();
        if (!managerInstance) {
            return res.status(500).json({ error: 'Lavalink not initialized' });
        }

        let searchQuery = url;
        if (!url.startsWith('http')) {
            searchQuery = `ytsearch:${url}`;
        }

        console.log(`Searching with Lavalink: ${searchQuery}`);

        try {
            // Use the first available node to search
            const nodes = managerInstance.nodeManager.nodes;
            if (nodes.size === 0) {
                return res.status(500).json({ error: 'No Lavalink nodes available' });
            }

            const node = nodes.values().next().value;
            const result = await node.search({
                query: searchQuery,
                requester: {
                    id: req.user.id,
                    username: req.user.username,
                    discriminator: req.user.discriminator || '0000',
                    tag: `${req.user.username}#${req.user.discriminator || '0000'}`,
                    originalRequester: req.user.username
                }
            });

            if (!result || !result.tracks || result.tracks.length === 0) {
                return res.status(400).json({ error: 'No songs found for your search. Please try different keywords.' });
            }

            // Use the exact track from the direct URL search
            let track = result.tracks[0];

            // Only fall back to title search if the direct URL search completely failed
            // This ensures we play the exact YouTube video that was requested

            // Helper function to format duration
            function formatDuration(seconds) {
                if (!seconds || seconds < 0) return '0:00';
                const minutes = Math.floor(seconds / 60);
                const remainingSeconds = seconds % 60;
                return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
            }

            const trackDuration = track.info.length; // This is in milliseconds

            // Store original requester info in the track object for preservation
            track.originalRequester = req.user.username;
            if (track.info) {
                track.info.originalRequester = req.user.username;
            }

            const song = {
                title: track.info.title,
                url: track.info.uri,
                duration: Math.floor(trackDuration / 1000),
                formattedDuration: formatDuration(trackDuration),
                thumbnail: track.info.artworkUrl || track.info.artwork || null,
                requestedBy: req.user.username, // Use authenticated user's username directly
                track: track
            };

            console.log('Adding song to queue:', song.title);

            const musicQueue = getMusicQueue(guildId);
            musicQueue.queue.push(song);
            musicQueue.voiceChannel = channelId;

            // Check if player exists and is active
            const existingPlayer = managerInstance.getPlayer(guildId);

            if (!musicQueue.isPlaying && !musicQueue.currentSong) {
                // No music playing, start fresh
                console.log('Starting playback...');
                await playNextSong(guildId, wss);
            } else if (existingPlayer && existingPlayer.connected) {
                // Music is playing, add to Lavalink queue
                try {
                    await existingPlayer.queue.add(song.track);
                    console.log(`Added "${song.title}" to Lavalink queue. Queue size now: ${existingPlayer.queue.size}`);

                    // Sync the app queue with Lavalink queue
                    try {
                        const lavalinkTracks = [];
                        if (existingPlayer.queue && existingPlayer.queue.tracks && Array.isArray(existingPlayer.queue.tracks)) {
                            lavalinkTracks.push(...existingPlayer.queue.tracks);
                        } else if (existingPlayer.queue && existingPlayer.queue.length > 0) {
                            // Try alternative queue access
                            for (let i = 0; i < existingPlayer.queue.length; i++) {
                                if (existingPlayer.queue[i]) {
                                    lavalinkTracks.push(existingPlayer.queue[i]);
                                }
                            }
                        }

                        console.log(`Found ${lavalinkTracks.length} tracks in Lavalink queue after adding`);

                        musicQueue.queue = lavalinkTracks.map(lavalinkTrack => ({
                            title: lavalinkTrack.info.title,
                            url: lavalinkTrack.info.uri,
                            duration: Math.floor(lavalinkTrack.info.length / 1000),
                            thumbnail: lavalinkTrack.info.artworkUrl,
                            requestedBy: req.user.username, // Use authenticated user for all queue items
                            track: lavalinkTrack
                        }));
                        console.log(`Synced app queue after adding song: ${musicQueue.queue.length} songs`);
                    } catch (syncError) {
                        console.error('Error syncing queue after adding song:', syncError);
                    }
                } catch (queueError) {
                    console.error('Error adding to Lavalink queue:', queueError.message);
                    // Remove from app queue if Lavalink add failed
                    musicQueue.queue.pop();
                    return res.status(500).json({ error: 'Failed to add song to queue: ' + queueError.message });
                }
            }

            broadcastMusicUpdate(guildId, musicQueue, wss);

            // Log music activity
            const moderator = {
                id: req.user.id,
                tag: `${req.user.username}#${req.user.discriminator || '0000'}`
            };
            await logAction(guildId, 'MUSIC_PLAY', moderator, null, `Added "${song.title}" to music queue`, {
                channelName: channel.name
            }, wss);

            res.json({
                success: true,
                message: `Added "${song.title}" to queue`,
                song
            });

        } catch (searchError) {
            console.error('Lavalink search error:', searchError);
            return res.status(500).json({ error: 'Failed to search for songs. Please try again.' });
        }

    } catch (error) {
        console.error('Music play error:', error);
        res.status(500).json({
            error: 'Internal server error while processing your request',
            details: error.message
        });
    }
});

// Music queue management endpoints
router.get('/dashboard/:guildId/music/queue', ensureDjOrAdmin, (req, res) => {
    const { guildId } = req.params;

    try {
        const musicQueue = getMusicQueue(guildId);
        res.json({
            success: true,
            queue: musicQueue.queue,
            currentSong: musicQueue.currentSong,
            isPlaying: musicQueue.isPlaying,
            volume: musicQueue.volume
        });
    } catch (error) {
        console.error('Error fetching music queue:', error);
        res.status(500).json({ error: 'Failed to fetch music queue' });
    }
});

router.post('/dashboard/:guildId/music/skip', ensureDjOrAdmin, async (req, res) => {
    const { guildId } = req.params;

    try {
        const managerInstance = manager();
        if (!managerInstance) {
            return res.status(500).json({ error: 'Lavalink not initialized' });
        }

        const player = managerInstance.getPlayer(guildId);
        if (!player) {
            return res.status(400).json({ error: 'No active player found. Start playing music first.' });
        }

        if (!player.connected) {
            return res.status(400).json({ error: 'Player not connected to voice channel' });
        }

        const musicQueue = getMusicQueue(guildId);
        if (!musicQueue.currentSong && musicQueue.queue.length === 0) {
            return res.status(400).json({ error: 'No songs to skip' });
        }

        // Get queue sizes from multiple sources for better accuracy
        const lavalinkQueueSize = player.queue ? (player.queue.size || player.queue.length || 0) : 0;
        const lavalinkTracks = player.queue?.tracks ? player.queue.tracks.length : 0;
        const totalLavalinkQueue = Math.max(lavalinkQueueSize, lavalinkTracks);

        console.log(`Attempting skip - Lavalink queue size: ${totalLavalinkQueue}, App queue size: ${musicQueue.queue.length}`);

        // Check both Lavalink queue and app queue for songs
        const hasNextSong = totalLavalinkQueue > 0 || musicQueue.queue.length > 0;

        if (!hasNextSong) {
            // No songs in queue to skip to, but keep current song playing
            console.log('No songs in queue to skip to, keeping current song playing');
            res.json({
                success: true,
                message: 'No more songs in queue, continuing current song',
                nextSong: musicQueue.currentSong?.title || 'Current song'
            });
            return;
        }

        // There are songs to skip to, try to skip
        try {
            await player.skip();

            // Log skip action
            const moderator = {
                id: req.user.id,
                tag: `${req.user.username}#${req.user.discriminator || '0000'}`
            };
            await logAction(guildId, 'MUSIC_SKIP', moderator, null, 'Skipped current song via dashboard', {}, wss);

            res.json({
                success: true,
                message: 'Skipped current song',
                nextSong: player.queue.current?.info?.title || 'Next song'
            });
        } catch (skipError) {
            console.error('Lavalink skip error:', skipError.message);

            // Handle common skip errors
            if (skipError.message && (skipError.message.includes('queue size') || skipError.message.includes('Can\'t skip'))) {
                console.log('Queue size error detected, attempting to stop current track');
                try {
                    await player.stopTrack();
                    res.json({
                        success: true,
                        message: 'Skipped to next song (stopped current track)',
                        nextSong: 'Next song'
                    });
                } catch (stopError) {
                    console.error('Stop track failed:', stopError.message);
                    // Last resort - destroy and restart
                    try {
                        await player.destroy();
                        musicQueue.currentSong = null;
                        musicQueue.isPlaying = false;
                        broadcastMusicUpdate(guildId, musicQueue, wss);

                        res.json({
                            success: true,
                            message: 'Player restarted (skip error recovery)',
                            nextSong: null
                        });
                    } catch (destroyError) {
                        console.error('Failed to destroy player:', destroyError.message);
                        res.status(500).json({
                            success: false,
                            error: 'Failed to skip song: ' + skipError.message
                        });
                    }
                }
            } else {
                throw skipError; // Re-throw if it's not a queue size error
            }
        }
    } catch (error) {
        console.error('Skip operation failed:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to skip song: ' + error.message
        });
    }
});

router.post('/dashboard/:guildId/music/pause', ensureDjOrAdmin, async (req, res) => {
    const { guildId } = req.params;

    try {
        const managerInstance = manager();
        if (!managerInstance) {
            return res.status(500).json({ error: 'Lavalink not initialized' });
        }

        const player = managerInstance.getPlayer(guildId);
        if (!player) {
            return res.status(400).json({ error: 'No active player found. Start playing music first.' });
        }

        if (!player.connected) {
            return res.status(400).json({ error: 'Player not connected to voice channel' });
        }

        const musicQueue = getMusicQueue(guildId);

        // Check the actual player state from lavalink instead of relying on our internal state
        const actualPlayerState = player.paused;

        console.log(`Player state check - Internal isPlaying: ${musicQueue.isPlaying}, Lavalink paused: ${actualPlayerState}`);

        if (!actualPlayerState) {
            // Player is currently playing (not paused), so pause it
            try {
                await player.pause(true);
                musicQueue.isPlaying = false;
                broadcastMusicUpdate(guildId, musicQueue, wss);
                console.log(`Successfully paused player for guild ${guildId}`);
                res.json({
                    success: true,
                    message: 'Paused playback',
                    paused: true,
                    isPlaying: false
                });
            } catch (pauseError) {
                console.error(`Error pausing player:`, pauseError.message);
                if (pauseError.message && pauseError.message.includes('already paused')) {
                    // Player is already paused, sync our state
                    musicQueue.isPlaying = false;
                    broadcastMusicUpdate(guildId, musicQueue, wss);
                    res.json({
                        success: true,
                        message: 'Already paused',
                        paused: true,
                        isPlaying: false
                    });
                } else {
                    throw pauseError;
                }
            }
        } else {
            // Player is currently paused, so resume it
            try {
                await player.pause(false);
                musicQueue.isPlaying = true;
                broadcastMusicUpdate(guildId, musicQueue, wss);
                console.log(`Successfully resumed player for guild ${guildId}`);
                res.json({
                    success: true,
                    message: 'Resumed playback',
                    paused: false,
                    isPlaying: true
                });
            } catch (resumeError) {
                console.error(`Error resuming player:`, resumeError.message);
                if (resumeError.message && (resumeError.message.includes('not paused') || resumeError.message.includes('already playing'))) {
                    // Player is already playing, sync our state
                    musicQueue.isPlaying = true;
                    broadcastMusicUpdate(guildId, musicQueue, wss);
                    res.json({
                        success: true,
                        message: 'Already playing',
                        paused: false,
                        isPlaying: true
                    });
                } else {
                    throw resumeError;
                }
            }
        }
    } catch (error) {
        console.error('Error pausing/resuming:', error);
        res.status(500).json({ error: 'Failed to pause/resume: ' + error.message });
    }
});

router.post('/dashboard/:guildId/music/stop', ensureDjOrAdmin, async (req, res) => {
    const { guildId } = req.params;

    try {
        const managerInstance = manager();
        if (!managerInstance) {
            return res.status(500).json({ error: 'Lavalink not initialized' });
        }

        const player = managerInstance.getPlayer(guildId);
        if (!player) {
            return res.status(400).json({ error: 'No active player found. Start playing music first.' });
        }

        const musicQueue = getMusicQueue(guildId);

        // Clear the queue and stop current song
        musicQueue.queue = [];
        musicQueue.currentSong = null;
        musicQueue.isPlaying = false;

        // Use destroy instead of stop for lavalink-client
        try {
            await player.destroy();
        } catch (destroyError) {
            console.log('Player destroy error (might be already destroyed):', destroyError.message);
        }

        // Log stop action
        const moderator = {
            id: req.user.id,
            tag: `${req.user.username}#${req.user.discriminator || '0000'}`
        };
        await logAction(guildId, 'MUSIC_STOP', moderator, null, 'Music stopped and queue cleared via dashboard', {}, wss);

        // Broadcast the update
        broadcastMusicUpdate(guildId, musicQueue, wss);

        res.json({
            success: true,
            message: 'Music stopped and queue cleared'
        });
    } catch (error) {
        console.error('Error stopping music:', error);
        res.status(500).json({ error: 'Failed to stop music: ' + error.message });
    }
});

// GET route for resume (for compatibility)
router.get('/dashboard/:guildId/music/resume', ensureDjOrAdmin, async (req, res) => {
    const { guildId } = req.params;

    try {
        const managerInstance = manager();
        if (!managerInstance) {
            return res.status(500).json({ error: 'Lavalink not initialized' });
        }

        const player = managerInstance.getPlayer(guildId);
        if (!player) {
            return res.status(400).json({ error: 'No active player found. Start playing music first.' });
        }

        if (!player.connected) {
            return res.status(400).json({ error: 'Player not connected to voice channel' });
        }

        const musicQueue = getMusicQueue(guildId);

        console.log(`Resume request - Internal state: ${musicQueue.isPlaying}, Lavalink paused: ${player.paused}`);

        if (!player.paused) {
            // Player is already playing, sync our state
            musicQueue.isPlaying = true;
            broadcastMusicUpdate(guildId, musicQueue, wss);
            return res.json({
                success: true,
                message: 'Already playing',
                paused: false,
                isPlaying: true
            });
        }

        // Player is paused, so resume it
        await player.resume();
        musicQueue.isPlaying = true;
        broadcastMusicUpdate(guildId, musicQueue, wss);

        res.json({
            success: true,
            message: 'Resumed playback',
            paused: false,
            isPlaying: true
        });
    } catch (error) {
        console.error('Error resuming music:', error);
        res.status(500).json({ error: 'Failed to resume music: ' + error.message });
    }
});

router.post('/dashboard/:guildId/music/resume', ensureDjOrAdmin, async (req, res) => {
    const { guildId } = req.params;

    try {
        const managerInstance = manager();
        if (!managerInstance) {
            return res.status(500).json({ error: 'Lavalink not initialized' });
        }

        const player = managerInstance.getPlayer(guildId);
        if (!player) {
            return res.status(400).json({ error: 'No active player found. Start playing music first.' });
        }

        if (!player.connected) {
            return res.status(400).json({ error: 'Player not connected to voice channel' });
        }

        const musicQueue = getMusicQueue(guildId);

        console.log(`Resume request - Internal state: ${musicQueue.isPlaying}, Lavalink paused: ${player.paused}`);

        if (!player.paused) {
            // Player is already playing, sync our state
            musicQueue.isPlaying = true;
            broadcastMusicUpdate(guildId, musicQueue, wss);
            return res.json({
                success: true,
                message: 'Already playing',
                paused: false,
                isPlaying: true
            });
        }

        // Player is paused, so resume it
        await player.resume();
        musicQueue.isPlaying = true;
        broadcastMusicUpdate(guildId, musicQueue, wss);

        res.json({
            success: true,
            message: 'Resumed playback',
            paused: false,
            isPlaying: true
        });
    } catch (error) {
        console.error('Error resuming music:', error);
        res.status(500).json({ error: 'Failed to resume music: ' + error.message });
    }
});

router.post('/dashboard/:guildId/music/volume', ensureDjOrAdmin, async (req, res) => {
    const { guildId } = req.params;
    const { volume } = req.body;

    if (typeof volume !== 'number' || volume < 0 || volume > 100) {
        return res.status(400).json({ error: 'Volume must be between 0 and 100' });
    }

    try {
        const managerInstance = manager();
        const musicQueue = getMusicQueue(guildId);

        // Update the queue's volume setting
        musicQueue.volume = volume;

        if (managerInstance) {
            const player = managerInstance.getPlayer(guildId);
            if (player && player.connected) {
                await player.setVolume(volume);
                console.log(`Volume set to ${volume}% for guild ${guildId}`);
            } else if (player) {
                console.log(`Volume will be set to ${volume}% when player connects for guild ${guildId}`);
            }
        }

        // Log volume change
        const moderator = {
            id: req.user.id,
            tag: `${req.user.username}#${req.user.discriminator || '0000'}`
        };
        await logAction(guildId, 'MUSIC_VOLUME', moderator, null, `Volume changed to ${volume}%`, {}, wss);

        // Broadcast the update to all connected WebSocket clients
        broadcastMusicUpdate(guildId, musicQueue, wss, 'volume_only');

        res.json({
            success: true,
            message: `Volume set to ${volume}%`,
            volume: volume,
            playerConnected: managerInstance ?
                (managerInstance.getPlayer(guildId)?.connected || false) : false
        });
    } catch (error) {
        console.error('Error setting volume:', error);
        res.status(500).json({ error: 'Failed to set volume: ' + error.message });
    }
});

router.delete('/dashboard/:guildId/music/queue/:index', ensureDjOrAdmin, (req, res) => {
    const { guildId, index } = req.params;

    try {
        const musicQueue = getMusicQueue(guildId);
        const queueIndex = parseInt(index);

        if (isNaN(queueIndex) || queueIndex < 0 || queueIndex >= musicQueue.queue.length) {
            return res.status(400).json({ error: 'Invalid queue index' });
        }

        const removedSong = musicQueue.queue.splice(queueIndex, 1)[0];
        broadcastMusicUpdate(guildId, musicQueue, wss);

        res.json({
            success: true,
            message: `Removed "${removedSong.title}" from queue`
        });
    } catch (error) {
        console.error('Error removing song from queue:', error);
        res.status(500).json({ error: 'Failed to remove song from queue' });
    }
});

// Get current playback position
router.get('/dashboard/:guildId/music/position', ensureDjOrAdmin, async (req, res) => {
    const { guildId } = req.params;

    try {
        const musicQueue = getMusicQueue(guildId);
        const managerInstance = manager();
        let position = 0;
        let duration = 0;
        let isPlaying = false;

        if (managerInstance) {
            const player = managerInstance.getPlayer(guildId);
            if (player && player.connected && player.queue && player.queue.current) {
                position = player.position || 0;
                duration = player.queue.current.info.length || 0;
                isPlaying = !player.paused;
            }
        }

        // Get duration from current song if available
        if (musicQueue.currentSong && musicQueue.currentSong.duration) {
            duration = musicQueue.currentSong.duration * 1000; // Convert to milliseconds
        }

        res.json({
            success: true,
            position: Math.floor(position / 1000), // Convert to seconds
            duration: Math.floor(duration / 1000), // Convert to seconds
            isPlaying: isPlaying,
            currentSong: musicQueue.currentSong
        });
    } catch (error) {
        console.error('Error getting position:', error);
        res.status(500).json({ error: 'Failed to get position' });
    }
});

// Get guild roles
router.get('/dashboard/:guildId/roles', ensureRole, async (req, res) => {
    const { guildId } = req.params;

    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild) {
        return res.status(403).json({ error: 'Access denied' });
    }

    // Only special role OR Discord admin permissions can access roles API
    if (!req.userRole || (!req.userRole.hasSpecialRole && !req.userRole.hasDiscordAdminPerms)) {
        return res.status(403).json({ error: 'You need Access role or Discord Administrator/Manage Server permissions to view roles' });
    }

    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            return res.status(404).json({ error: 'Guild not found' });
        }

        const roles = guild.roles.cache
            .filter(role => role.id !== guild.id) // Exclude @everyone role
            .map(role => ({
                id: role.id,
                name: role.name,
                color: role.hexColor,
                position: role.position,
                permissions: role.permissions.bitfield.toString(),
                mentionable: role.mentionable,
                hoist: role.hoist,
                managed: role.managed,
                memberCount: role.members.size
            }))
            .sort((a, b) => b.position - a.position);

        res.json({
            success: true,
            roles: roles
        });
    } catch (error) {
        console.error('Error fetching guild roles:', error);
        res.status(500).json({ error: 'Failed to fetch guild roles' });
    }
});

// Get guild members
router.get('/dashboard/:guildId/members', ensureRole, async (req, res) => {
    const { guildId } = req.params;
    const { page = 1, search = '', role = '', sort = 'newest', limit = 50 } = req.query;

    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild) {
        return res.status(403).json({ error: 'Access denied' });
    }

    // Only special role OR Discord admin permissions can access members API
    if (!req.userRole || (!req.userRole.hasSpecialRole && !req.userRole.hasDiscordAdminPerms)) {
        return res.status(403).json({ error: 'You need Access role or Discord Administrator/Manage Server permissions to view members' });
    }

    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            return res.status(404).json({ error: 'Guild not found' });
        }

        // Fetch members if needed
        await guild.members.fetch({ limit: 1000, force: false });

        let members = Array.from(guild.members.cache.values());

        // Filter out bots first
        members = members.filter(member => !member.user.bot);

        // Apply search filter
        if (search) {
            const searchTerm = search.toLowerCase();
            members = members.filter(member =>
                member.user.username.toLowerCase().includes(searchTerm) ||
                member.user.tag.toLowerCase().includes(searchTerm) ||
                (member.nickname && member.nickname.toLowerCase().includes(searchTerm))
            );
        }

        // Apply role filter
        if (role) {
            members = members.filter(member => member.roles.cache.has(role));
        }

        // Apply sorting
        switch (sort) {
            case 'newest':
                members.sort((a, b) => b.joinedTimestamp - a.joinedTimestamp);
                break;
            case 'oldest':
                members.sort((a, b) => a.joinedTimestamp - b.joinedTimestamp);
                break;
            case 'username':
                members.sort((a, b) => a.user.username.localeCompare(b.user.username));
                break;
            default:
                members.sort((a, b) => b.joinedTimestamp - a.joinedTimestamp);
        }

        // Apply pagination
        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const offset = (pageNum - 1) * limitNum;
        const totalMembers = members.length;
        const paginatedMembers = members.slice(offset, offset + limitNum);

        const membersData = paginatedMembers.map(member => ({
            id: member.user.id,
            username: member.user.username,
            nickname: member.nickname,
            tag: member.user.tag,
            avatar: member.user.displayAvatarURL(),
            joinedAt: member.joinedTimestamp,
            createdAt: member.user.createdTimestamp,
            roles: member.roles.cache
                .filter(role => role.id !== guild.id)
                .map(role => ({
                    id: role.id,
                    name: role.name,
                    color: role.hexColor
                })),
            isBot: member.user.bot,
            status: member.presence?.status || 'offline'
        }));

        res.json({
            success: true,
            members: membersData,
            pagination: {
                current: pageNum,
                total: Math.ceil(totalMembers / limitNum),
                hasNext: offset + limitNum < totalMembers,
                hasPrev: pageNum > 1,
                totalMembers: totalMembers
            }
        });
    } catch (error) {
        console.error('Error fetching guild members:', error);
        res.status(500).json({ error: 'Failed to fetch guild members' });
    }
});

// Get audit logs
router.get('/dashboard/:guildId/logs', ensureRole, async (req, res) => {
    const { guildId } = req.params;
    const { page = 1, limit = 50, action = '', category = '', search = '', startDate = '', endDate = '' } = req.query;

    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild) {
        return res.status(403).json({ error: 'Access denied' });
    }

    // Only special role OR Discord admin permissions can access audit logs API
    if (!req.userRole || (!req.userRole.hasSpecialRole && !req.userRole.hasDiscordAdminPerms)) {
        return res.status(403).json({ error: 'You need Access role or Discord Administrator/Manage Server permissions to view audit logs' });
    }

    try {
        const { AuditLog } = require('../utils/auditLogger');
        const { Op } = require('sequelize');

        const whereClause = { guildId };

        // Apply filters
        if (action && action !== '') {
            whereClause.action = action;
        }
        if (category && category !== '') {
            whereClause.category = category;
        }
        if (search && search !== '') {
            whereClause[Op.or] = [
                { moderatorTag: { [Op.iLike]: `%${search}%` } },
                { targetTag: { [Op.iLike]: `%${search}%` } },
                { reason: { [Op.iLike]: `%${search}%` } },
                { channelName: { [Op.iLike]: `%${search}%` } }
            ];
        }
        if (startDate && startDate !== '') {
            if (!whereClause.timestamp) whereClause.timestamp = {};
            whereClause.timestamp[Op.gte] = new Date(startDate);
        }
        if (endDate && endDate !== '') {
            if (!whereClause.timestamp) whereClause.timestamp = {};
            const endDateTime = new Date(endDate);
            endDateTime.setHours(23, 59, 59, 999);
            whereClause.timestamp[Op.lte] = endDateTime;
        }

        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const offset = (pageNum - 1) * limitNum;

        const result = await AuditLog.findAndCountAll({
            where: whereClause,
            order: [['timestamp', 'DESC']],
            limit: limitNum,
            offset: offset
        });

        res.json({
            success: true,
            logs: result.rows,
            pagination: {
                current: pageNum,
                total: Math.ceil(result.count / limitNum),
                hasNext: offset + limitNum < result.count,
                hasPrev: pageNum > 1,
                totalLogs: result.count,
                currentPage: pageNum,
                totalPages: Math.ceil(result.count / limitNum)
            }
        });
    } catch (error) {
        console.error('Error fetching audit logs:', error);
        res.status(500).json({ error: 'Failed to fetch audit logs' });
    }
});

// API endpoint to get current configuration
router.get('/dashboard/:guildId/config', ensureRole, async (req, res) => {
    const { guildId } = req.params;

    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild) {
        return res.status(403).json({ error: 'Access denied' });
    }

    // Only special role OR Discord admin permissions can access configuration API
    if (!req.userRole || (!req.userRole.hasSpecialRole && !req.userRole.hasDiscordAdminPerms)) {
        return res.status(403).json({ error: 'You need Access role or Discord Administrator/Manage Server permissions to view configuration' });
    }

    try {
        const config = await getOrCreateGuildConfig(guildId);

        let roleConfigs = config.roleConfigs;
        if (typeof roleConfigs === 'string') {
            try {
                roleConfigs = JSON.parse(roleConfigs);
            } catch (parseError) {
                console.error('Error parsing roleConfigs JSON:', parseError);
                roleConfigs = [];
            }
        }

        if (!Array.isArray(roleConfigs)) {
            roleConfigs = [];
        }

        res.json({
            success: true,
            config: {
                prefix: config.prefix,
                logChannel: config.logChannel,
                specialSuffix: config.specialSuffix,
                roleConfigs: roleConfigs
            }
        });
    } catch (error) {
        console.error('Error fetching configuration:', error);
        res.status(500).json({ error: 'Failed to fetch configuration' });
    }
});

// API endpoint to update configuration
router.post('/dashboard/:guildId/config', ensureRole, async (req, res) => {
    const { guildId } = req.params;
    const { prefix, logChannel, specialSuffix, roleConfigs } = req.body;

    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild) {
        return res.status(403).json({ error: 'Access denied' });
    }

    // Only special role OR Discord admin permissions can access configuration API
    if (!req.userRole || (!req.userRole.hasSpecialRole && !req.userRole.hasDiscordAdminPerms)) {
        return res.status(403).json({ error: 'You need Access role or Discord Administrator/Manage Server permissions to update configuration' });
    }

    try {
        const config = await getOrCreateGuildConfig(guildId);

        // Update configuration fields
        if (prefix !== undefined) config.prefix = prefix;
        if (logChannel !== undefined) config.logChannel = logChannel;
        if (specialSuffix !== undefined) config.specialSuffix = specialSuffix;
        if (roleConfigs !== undefined) {
            config.roleConfigs = Array.isArray(roleConfigs) ? roleConfigs : [];
        }

        await config.save();

        // Log the configuration update
        const moderator = {
            id: req.user.id,
            tag: `${req.user.username}#${req.user.discriminator || '0000'}`
        };

        await logAction(guildId, 'BOT_CONFIG_UPDATE', moderator, null, 'Configuration updated via dashboard', {}, wss);

        res.json({
            success: true,
            message: 'Configuration updated successfully',
            config: {
                prefix: config.prefix,
                logChannel: config.logChannel,
                specialSuffix: config.specialSuffix,
                roleConfigs: config.roleConfigs
            }
        });
    } catch (error) {
        console.error('Error updating configuration:', error);
        res.status(500).json({ error: 'Failed to update configuration' });
    }
});

// Member management API endpoints
router.post('/dashboard/:guildId/member/:memberId/role', ensureRole, async (req, res) => {
    const { guildId, memberId } = req.params;
    const { roleId, action } = req.body;

    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild) {
        return res.status(403).json({ error: 'Access denied' });
    }

    // Only users with BOTH Access role AND Discord admin permissions can manage roles
    if (!req.userRole || !req.userRole.hasAdminPermissions) {
        return res.status(403).json({ error: 'You need both the Access role AND Discord Administrator/Manage Server permissions to manage roles' });
    }

    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            return res.status(404).json({ error: 'Guild not found' });
        }

        const member = await guild.members.fetch(memberId);
        if (!member) {
            return res.status(404).json({ error: 'Member not found' });
        }

        const role = guild.roles.cache.get(roleId);
        if (!role) {
            return res.status(404).json({ error: 'Role not found' });
        }

        // Check if the bot can manage this role
        const botMember = guild.members.me;
        if (role.position >= botMember.roles.highest.position) {
            return res.status(403).json({ error: 'Cannot manage role: Role is higher than or equal to bot\'s highest role' });
        }

        // Check if the user trying to manage the role has permission
        const userMember = await guild.members.fetch(req.user.id);
        if (role.position >= userMember.roles.highest.position && guild.ownerId !== req.user.id) {
            return res.status(403).json({ error: 'Cannot manage role: Role is higher than or equal to your highest role' });
        }

        let actionTaken = '';
        if (action === 'add') {
            if (member.roles.cache.has(roleId)) {
                return res.status(400).json({ error: 'Member already has this role' });
            }
            await member.roles.add(roleId);
            actionTaken = 'added';
        } else if (action === 'remove') {
            if (!member.roles.cache.has(roleId)) {
                return res.status(400).json({ error: 'Member does not have this role' });
            }
            await member.roles.remove(roleId);
            actionTaken = 'removed';
        } else {
            return res.status(400).json({ error: 'Invalid action. Use "add" or "remove"' });
        }

        // Log the role change
        const moderator = {
            id: req.user.id,
            tag: `${req.user.username}#${req.user.discriminator || '0000'}`
        };

        await logAction(guildId, action === 'add' ? 'ROLE_ADD' : 'ROLE_REMOVE', moderator, member.user, 
            `Role ${actionTaken}: ${role.name}`, {}, wss);

        res.json({
            success: true,
            message: `Role ${role.name} ${actionTaken} successfully`,
            action: actionTaken,
            role: {
                id: role.id,
                name: role.name
            }
        });
    } catch (error) {
        console.error('Error managing member role:', error);
        res.status(500).json({ error: 'Failed to manage member role: ' + error.message });
    }
});

router.post('/dashboard/:guildId/member/:memberId/nickname', ensureRole, async (req, res) => {
    const { guildId, memberId } = req.params;
    const { nickname } = req.body;

    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild) {
        return res.status(403).json({ error: 'Access denied' });
    }

    // Only users with BOTH Access role AND Discord admin permissions can change nicknames
    if (!req.userRole || !req.userRole.hasAdminPermissions) {
        return res.status(403).json({ error: 'You need both the Access role AND Discord Administrator/Manage Server permissions to change nicknames' });
    }

    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            return res.status(404).json({ error: 'Guild not found' });
        }

        const member = await guild.members.fetch(memberId);
        if (!member) {
            return res.status(404).json({ error: 'Member not found' });
        }

        // Check if we can change this member's nickname
        if (member.id === guild.ownerId) {
            return res.status(403).json({ error: 'Cannot change server owner\'s nickname' });
        }

        const botMember = guild.members.me;
        if (member.roles.highest.position >= botMember.roles.highest.position) {
            return res.status(403).json({ error: 'Cannot change nickname: Member has higher or equal roles to bot' });
        }

        const oldNickname = member.nickname;
        const newNickname = nickname && nickname.trim() ? nickname.trim() : null;

        // Validate nickname length
        if (newNickname && newNickname.length > 32) {
            return res.status(400).json({ error: 'Nickname cannot be longer than 32 characters' });
        }

        await member.setNickname(newNickname);

        // Save custom nickname to database if provided
        if (newNickname) {
            const { saveCustomNickname } = require('../utils/guildUtils');
            await saveCustomNickname(member.user.id, guildId, newNickname);
        } else {
            const { deleteCustomNickname } = require('../utils/guildUtils');
            await deleteCustomNickname(member.user.id, guildId);
        }

        // Log the nickname change
        const moderator = {
            id: req.user.id,
            tag: `${req.user.username}#${req.user.discriminator || '0000'}`
        };

        await logAction(guildId, 'NICKNAME_CHANGE', moderator, member.user, 
            `Nickname changed from "${oldNickname || 'None'}" to "${newNickname || 'None'}"`, {}, wss);

        res.json({
            success: true,
            message: 'Nickname changed successfully',
            oldNickname: oldNickname,
            newNickname: newNickname
        });
    } catch (error) {
        console.error('Error changing member nickname:', error);
        res.status(500).json({ error: 'Failed to change nickname: ' + error.message });
    }
});

router.post('/dashboard/:guildId/member/:memberId/kick', ensureRole, async (req, res) => {
    const { guildId, memberId } = req.params;
    const { reason } = req.body;

    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild) {
        return res.status(403).json({ error: 'Access denied' });
    }

    // Only users with BOTH Access role AND Discord admin permissions can kick members
    if (!req.userRole || !req.userRole.hasAdminPermissions) {
        return res.status(403).json({ error: 'You need both the Access role AND Discord Administrator/Manage Server permissions to kick members' });
    }

    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            return res.status(404).json({ error: 'Guild not found' });
        }

        const member = await guild.members.fetch(memberId);
        if (!member) {
            return res.status(404).json({ error: 'Member not found' });
        }

        // Check if we can kick this member
        if (member.id === guild.ownerId) {
            return res.status(403).json({ error: 'Cannot kick server owner' });
        }

        const botMember = guild.members.me;
        if (member.roles.highest.position >= botMember.roles.highest.position) {
            return res.status(403).json({ error: 'Cannot kick member: Member has higher or equal roles to bot' });
        }

        const userMember = await guild.members.fetch(req.user.id);
        if (member.roles.highest.position >= userMember.roles.highest.position && guild.ownerId !== req.user.id) {
            return res.status(403).json({ error: 'Cannot kick member: Member has higher or equal roles to you' });
        }

        const kickReason = reason && reason.trim() ? reason.trim() : 'No reason provided';
        
        await member.kick(kickReason);

        // Log the kick
        const moderator = {
            id: req.user.id,
            tag: `${req.user.username}#${req.user.discriminator || '0000'}`
        };

        await logAction(guildId, 'MEMBER_KICK', moderator, member.user, kickReason, {}, wss);

        res.json({
            success: true,
            message: 'Member kicked successfully',
            reason: kickReason
        });
    } catch (error) {
        console.error('Error kicking member:', error);
        res.status(500).json({ error: 'Failed to kick member: ' + error.message });
    }
});

router.post('/dashboard/:guildId/member/:memberId/ban', ensureRole, async (req, res) => {
    const { guildId, memberId } = req.params;
    const { reason, deleteMessages } = req.body;

    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild) {
        return res.status(403).json({ error: 'Access denied' });
    }

    // Only users with BOTH Access role AND Discord admin permissions can ban members
    if (!req.userRole || !req.userRole.hasAdminPermissions) {
        return res.status(403).json({ error: 'You need both the Access role AND Discord Administrator/Manage Server permissions to ban members' });
    }

    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            return res.status(404).json({ error: 'Guild not found' });
        }

        let member;
        let user;
        
        try {
            member = await guild.members.fetch(memberId);
            user = member.user;
        } catch {
            // Member might not be in guild, try to get user directly
            try {
                user = await client.users.fetch(memberId);
            } catch {
                return res.status(404).json({ error: 'User not found' });
            }
        }

        // Check if we can ban this member (if they're in the guild)
        if (member) {
            if (member.id === guild.ownerId) {
                return res.status(403).json({ error: 'Cannot ban server owner' });
            }

            const botMember = guild.members.me;
            if (member.roles.highest.position >= botMember.roles.highest.position) {
                return res.status(403).json({ error: 'Cannot ban member: Member has higher or equal roles to bot' });
            }

            const userMember = await guild.members.fetch(req.user.id);
            if (member.roles.highest.position >= userMember.roles.highest.position && guild.ownerId !== req.user.id) {
                return res.status(403).json({ error: 'Cannot ban member: Member has higher or equal roles to you' });
            }
        }

        const banReason = reason && reason.trim() ? reason.trim() : 'No reason provided';
        const deleteMessageDays = deleteMessages ? 7 : 0;
        
        await guild.members.ban(user, { 
            reason: banReason,
            deleteMessageDays: deleteMessageDays
        });

        // Log the ban
        const moderator = {
            id: req.user.id,
            tag: `${req.user.username}#${req.user.discriminator || '0000'}`
        };

        await logAction(guildId, 'MEMBER_BAN', moderator, user, banReason, {
            extra: { deleteMessages: deleteMessages }
        }, wss);

        res.json({
            success: true,
            message: 'Member banned successfully',
            reason: banReason,
            deleteMessages: deleteMessages
        });
    } catch (error) {
        console.error('Error banning member:', error);
        res.status(500).json({ error: 'Failed to ban member: ' + error.message });
    }
});

module.exports = { router, setWebSocketServer };
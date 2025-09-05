const { LavalinkManager } = require('lavalink-client');
const WebSocket = require('ws');

// Lavalink and music state management
const LAVALINK_HOST = process.env.LAVALINK_HOST || '104.248.32.109';
const LAVALINK_PORT = process.env.LAVALINK_PORT || '5564';
const LAVALINK_PASSWORD = process.env.LAVALINK_PASSWORD || 'Mate132005';

let lavalinkManager = null;
const musicQueues = new Map(); // guildId -> { queue, currentSong, isPlaying, volume, textChannel, voiceChannel, connection, player, inactivityTimer }

// Helper function to format duration in MM:SS format
function formatDuration(milliseconds) {
    if (!milliseconds || milliseconds < 0) return '0:00';
    const totalSeconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// Helper function to get proper track duration from Lavalink
function getTrackDuration(track) {
    if (!track) return 0;

    // Try different ways to get duration from Lavalink track
    // Lavalink returns duration in milliseconds in track.info.length
    if (track.info && typeof track.info.length === 'number' && track.info.length > 0) {
        return track.info.length; // This is in milliseconds
    }

    // Alternative property names for duration
    if (track.info && typeof track.info.duration === 'number' && track.info.duration > 0) {
        return track.info.duration;
    }

    if (typeof track.length === 'number' && track.length > 0) {
        return track.length;
    }

    if (typeof track.duration === 'number' && track.duration > 0) {
        return track.duration;
    }

    // If no duration found, log for debugging
    console.log('No valid duration found for track:', track?.info?.title || 'Unknown track');
    console.log('Track info:', JSON.stringify(track?.info || {}, null, 2));

    return 0;
}

// Update bot status
async function updateBotStatus(activity = null, status = 'online') {
    try {
        const client = require('../config/discord');
        const { ActivityType } = require('discord.js');

        if (!client.user) {
            console.log('Client user not available for status update');
            return;
        }

        // Set presence with activity and status
        await client.user.setPresence({
            activities: activity ? [{
                name: activity,
                type: ActivityType.Listening
            }] : [],
            status: status
        });

        console.log(`Bot status updated: ${activity || 'No activity'} (${status})`);
    } catch (error) {
        console.error('Error updating bot status:', error);
    }
}

function getMusicQueue(guildId) {
    if (!musicQueues.has(guildId)) {
        musicQueues.set(guildId, {
            queue: [],
            currentSong: null,
            isPlaying: false,
            volume: 50,
            textChannel: null,
            voiceChannel: null,
            connection: null,
            player: null,
            inactivityTimer: null
        });
    }
    return musicQueues.get(guildId);
}

// Clear inactivity timer
function clearInactivityTimer(guildId) {
    const musicQueue = getMusicQueue(guildId);
    if (musicQueue.inactivityTimer) {
        clearTimeout(musicQueue.inactivityTimer);
        musicQueue.inactivityTimer = null;
        console.log(`Cleared inactivity timer for guild ${guildId}`);
    }
}

// Start inactivity timer (5 minutes)
function startInactivityTimer(guildId, wss) {
    const musicQueue = getMusicQueue(guildId);

    // Clear any existing timer first
    clearInactivityTimer(guildId);

    // Set new timer for 2 minutes (120000 ms)
    musicQueue.inactivityTimer = setTimeout(async () => {
        console.log(`Inactivity timer expired for guild ${guildId}, disconnecting bot`);

        try {
            if (lavalinkManager) {
                const player = lavalinkManager.getPlayer(guildId);
                if (player) {
                    console.log(`Disconnecting bot from voice channel in guild ${guildId} due to 2 minutes of inactivity`);

                    // Clear all music state first
                    musicQueue.isPlaying = false;
                    musicQueue.currentSong = null;
                    musicQueue.queue = [];
                    musicQueue.connection = null;
                    musicQueue.player = null;
                    musicQueue.inactivityTimer = null;

                    // Clear bot status
                    await updateBotStatus(null, 'online');

                    // Clear voice channel status
                    await updateVoiceChannelStatus(guildId, null);

                    // Broadcast final state update before destroying player
                    broadcastMusicUpdate(guildId, musicQueue, wss, 'auto_disconnect');

                    // Destroy player and disconnect
                    try {
                        if (player.connected) {
                            await player.destroy();
                        }
                    } catch (destroyError) {
                        console.log(`Player destroy error (might already be destroyed): ${destroyError.message}`);
                    }

                    console.log(`Successfully disconnected from voice channel in guild ${guildId} after inactivity`);
                } else {
                    console.log(`No player found for guild ${guildId}, clearing state anyway`);

                    // Clear state even if no player
                    musicQueue.isPlaying = false;
                    musicQueue.currentSong = null;
                    musicQueue.queue = [];
                    musicQueue.connection = null;
                    musicQueue.player = null;
                    musicQueue.inactivityTimer = null;

                    // Clear statuses
                    await updateBotStatus(null, 'online');
                    await updateVoiceChannelStatus(guildId, null);

                    // Broadcast final state update
                    broadcastMusicUpdate(guildId, musicQueue, wss, 'auto_disconnect');
                }
            }
        } catch (error) {
            console.error(`Error during auto-disconnect for guild ${guildId}:`, error);

            // Force clear state even on error
            musicQueue.isPlaying = false;
            musicQueue.currentSong = null;
            musicQueue.queue = [];
            musicQueue.connection = null;
            musicQueue.player = null;
            musicQueue.inactivityTimer = null;

            // Try to clear statuses even on error
            try {
                await updateBotStatus(null, 'online');
                await updateVoiceChannelStatus(guildId, null);
                broadcastMusicUpdate(guildId, musicQueue, wss, 'auto_disconnect_error');
            } catch (statusError) {
                console.error(`Failed to clear statuses on error: ${statusError.message}`);
            }
        }
    }, 120000); // 2 minutes = 120000 milliseconds

    console.log(`Started 2-minute inactivity timer for guild ${guildId}`);
}

// Initialize Lavalink connection
async function initializeLavalink(client, wss) {
    try {
        // Ensure client is ready and has a user ID
        if (!client.user || !client.user.id) {
            console.error('Client user not available for Lavalink initialization');
            return;
        }

        console.log(`Connecting to Lavalink at ${LAVALINK_HOST}:${LAVALINK_PORT}`);

        lavalinkManager = new LavalinkManager({
            nodes: [
                {
                    authorization: LAVALINK_PASSWORD,
                    host: LAVALINK_HOST,
                    port: parseInt(LAVALINK_PORT),
                    id: "main_node",
                    secure: false
                }
            ],
            sendToShard: (guildId, payload) => {
                try {
                    const guild = client.guilds.cache.get(guildId);
                    if (guild && guild.shard) {
                        guild.shard.send(payload);
                    }
                } catch (error) {
                    console.error('Error sending to shard:', error);
                }
            },
            client: {
                id: client.user.id,
                username: client.user.username
            },
            autoSkip: true,
            autoPlay: true
        });

        lavalinkManager.nodeManager.on('connect', (node) => {
            console.log(`Lavalink node "${node.id}" connected successfully`);
        });

        lavalinkManager.nodeManager.on('disconnect', (node, reason) => {
            console.log(`Lavalink node "${node.id}" disconnected:`, reason);
        });

        lavalinkManager.nodeManager.on('error', (node, error) => {
            console.error(`Lavalink node "${node.id}" error:`, error);
        });

        lavalinkManager.on('trackStart', (player, track) => {
            const guildId = player.guildId;
            const musicQueue = getMusicQueue(guildId);

            console.log(`Track started in guild ${guildId}: ${track.info.title}`);
            console.log(`Player state on track start - paused: ${player.paused}`);

            // Clear inactivity timer since a song is now playing
            clearInactivityTimer(guildId);

            // Get proper duration from track
            const trackDuration = getTrackDuration(track);
            console.log(`Track started: ${track.info.title}`);
            console.log(`Raw track info:`, {
                length: track.info.length,
                duration: track.info.duration,
                isSeekable: track.info.isSeekable,
                isStream: track.info.isStream
            });
            console.log(`Parsed duration: ${trackDuration}ms (${Math.floor(trackDuration / 1000)}s)`);

            // Sync our state with the actual player state
            musicQueue.isPlaying = !player.paused;
            
            // Try to get original requester from track metadata first, fall back to track requester
            let requestedBy = 'Unknown User';
            if (track.originalRequester) {
                requestedBy = track.originalRequester;
            } else if (track.info && track.info.originalRequester) {
                requestedBy = track.info.originalRequester;
            } else if (track.requester?.originalRequester) {
                requestedBy = track.requester.originalRequester;
            } else if (track.requester?.tag) {
                requestedBy = track.requester.tag;
            } else if (track.requester?.username) {
                requestedBy = track.requester.username;
            }
            
            musicQueue.currentSong = {
                title: track.info.title,
                url: track.info.uri,
                duration: Math.floor(trackDuration / 1000), // Convert to seconds
                formattedDuration: formatDuration(trackDuration), // Pass milliseconds to format function
                thumbnail: track.info.artworkUrl || track.info.artwork || null,
                requestedBy: requestedBy
            };

            // Update bot status with currently playing song
            updateBotStatus(`🎵 ${track.info.title}`);

            // Update voice channel status
            updateVoiceChannelStatus(guildId, `🎵 ${track.info.title}`);

            // Sync app queue with Lavalink queue - the currently playing song should not be in the queue
            try {
                // Get tracks from Lavalink queue - use tracks array for lavalink-client
                const lavalinkTracks = [];
                if (player.queue && player.queue.tracks && Array.isArray(player.queue.tracks)) {
                    lavalinkTracks.push(...player.queue.tracks);
                } else if (player.queue && player.queue.length > 0) {
                    // Try alternative queue access
                    for (let i = 0; i < player.queue.length; i++) {
                        if (player.queue[i]) {
                            lavalinkTracks.push(player.queue[i]);
                        }
                    }
                }

                console.log(`Found ${lavalinkTracks.length} tracks in Lavalink queue`);

                // Always sync the app queue with Lavalink queue (which excludes the currently playing song)
                musicQueue.queue = lavalinkTracks.map(lavalinkTrack => {
                    const trackDuration = getTrackDuration(lavalinkTrack);
                    
                    // Try to get original requester from track metadata first
                    let requestedBy = 'Unknown User';
                    if (lavalinkTrack.originalRequester) {
                        requestedBy = lavalinkTrack.originalRequester;
                    } else if (lavalinkTrack.info && lavalinkTrack.info.originalRequester) {
                        requestedBy = lavalinkTrack.info.originalRequester;
                    } else if (lavalinkTrack.requester?.originalRequester) {
                        requestedBy = lavalinkTrack.requester.originalRequester;
                    } else if (lavalinkTrack.requester?.tag) {
                        requestedBy = lavalinkTrack.requester.tag;
                    } else if (lavalinkTrack.requester?.username) {
                        requestedBy = lavalinkTrack.requester.username;
                    }
                    
                    return {
                        title: lavalinkTrack.info.title,
                        url: lavalinkTrack.info.uri,
                        duration: Math.floor(trackDuration / 1000),
                        formattedDuration: formatDuration(trackDuration),
                        thumbnail: lavalinkTrack.info.artworkUrl,
                        requestedBy: requestedBy,
                        track: lavalinkTrack
                    };
                });

                console.log(`Synced app queue with Lavalink: ${musicQueue.queue.length} songs`);
            } catch (syncError) {
                console.error('Error syncing queue:', syncError);
                // If sync fails, at least try to remove the currently playing song from app queue
                const currentSongIndex = musicQueue.queue.findIndex(song => 
                    song.title === track.info.title || song.url === track.info.uri
                );
                if (currentSongIndex !== -1) {
                    musicQueue.queue.splice(currentSongIndex, 1);
                    console.log(`Removed currently playing song from app queue`);
                }
            }

            // Ensure player volume is set to the queue's volume setting
            if (player && player.connected) {
                player.setVolume(musicQueue.volume).then(() => {
                    console.log(`Volume set to ${musicQueue.volume}% for track in guild ${guildId}`);
                }).catch((error) => {
                    console.error(`Failed to set volume for guild ${guildId}:`, error);
                });
            }

            // Broadcast update
            console.log(`Broadcasting update for guild ${guildId}: playing=${musicQueue.isPlaying}, song=${musicQueue.currentSong?.title}`);
            broadcastMusicUpdate(guildId, musicQueue, wss, 'track_start');
        });

        lavalinkManager.on('trackEnd', async (player, track, reason) => {
            const guildId = player.guildId;
            const musicQueue = getMusicQueue(guildId);

            console.log(`Track ended in guild ${guildId}, reason: ${reason}`);

            // Clear any existing inactivity timer first
            clearInactivityTimer(guildId);

            // Immediately reset position and playing state to prevent timer issues
            musicQueue.isPlaying = false;

            // Get queue sizes from multiple sources
            const lavalinkQueueSize = player.queue ? (player.queue.size || player.queue.length || 0) : 0;
            const lavalinkTracks = player.queue?.tracks ? player.queue.tracks.length : 0;
            const totalLavalinkQueue = Math.max(lavalinkQueueSize, lavalinkTracks);

            console.log(`Track end - Lavalink queue: ${totalLavalinkQueue}, App queue: ${musicQueue.queue.length}`);

            // Check if there are more songs in either queue
            const hasNextSong = totalLavalinkQueue > 0 || musicQueue.queue.length > 0;

            // Check if this is a natural finish (not a skip/replace)
            const isNaturalFinish = reason && (reason.toString().includes('FINISHED') || reason === 'finished');

            if (!hasNextSong) {
                // No more songs in any queue - clear state but stay in voice for 2 minutes
                console.log('Track ended - No more songs in queue, clearing state and starting inactivity timer');

                // Clear music state but keep connection
                musicQueue.isPlaying = false;
                musicQueue.currentSong = null;
                musicQueue.queue = [];

                // Clear bot status immediately when music ends
                console.log('Clearing bot status after track end');
                await updateBotStatus(null, 'online');

                // Clear voice channel status immediately when music ends
                console.log('Clearing voice channel status after track end');
                await updateVoiceChannelStatus(guildId, null);

                // Broadcast the final state update with position reset
                broadcastMusicUpdate(guildId, musicQueue, wss, 'music_ended', true); // Force position reset

                // Start 2-minute inactivity timer
                console.log('Starting 2-minute inactivity timer after track end');
                startInactivityTimer(guildId, wss);

            } else if (totalLavalinkQueue === 0 && musicQueue.queue.length > 0) {
                // Lavalink queue is empty but app queue has songs - play next from app queue
                console.log('Lavalink queue empty, playing next song from app queue');

                // Reset current song to null before playing next
                musicQueue.currentSong = null;

                // Broadcast state update with reset position
                broadcastMusicUpdate(guildId, musicQueue, wss, 'track_ended', true); // Force position reset

                setTimeout(() => {
                    playNextSong(guildId, wss, true); // Skip intro for subsequent songs
                }, 500);
            } else {
                // Let Lavalink handle auto-progression if it has songs in queue
                console.log(`Lavalink will auto-progress to next song (${totalLavalinkQueue} songs in Lavalink queue)`);

                // Still reset the current song and broadcast update
                musicQueue.currentSong = null;
                broadcastMusicUpdate(guildId, musicQueue, wss, 'track_ended', true); // Force position reset
            }

            console.log(`Track end handled - hasNextSong: ${hasNextSong}, isNaturalFinish: ${isNaturalFinish}, reason: ${reason}`);
        });

        lavalinkManager.on('trackError', (player, track, error) => {
            const guildId = player.guildId;
            const musicQueue = getMusicQueue(guildId);

            console.error(`Track error in guild ${guildId}:`, error);

            // Clear inactivity timer since we're handling an error
            clearInactivityTimer(guildId);

            // Check if it's a YouTube authentication error
            if (error.exception && error.exception.message === 'Please sign in') {
                console.log('YouTube authentication error - this is a known issue with some YouTube videos');
                console.log('Trying to skip to next song...');
            }

            musicQueue.isPlaying = false;
            musicQueue.currentSong = null;

            // Clear bot status on error
            updateBotStatus(null, 'online');

            // Clear voice channel status on error
            updateVoiceChannelStatus(guildId, null);

            broadcastMusicUpdate(guildId, musicQueue, wss, 'track_error');

            // Try next song
            setTimeout(() => {
                playNextSong(guildId, wss, true); // Skip intro for error recovery
            }, 1000);
        });

        lavalinkManager.on('trackStuck', (player, track) => {
            const guildId = player.guildId;
            const musicQueue = getMusicQueue(guildId);

            console.log(`Track stuck in guild ${guildId}, skipping...`);

            // Clear inactivity timer since we're handling a stuck track
            clearInactivityTimer(guildId);
            musicQueue.isPlaying = false;
            musicQueue.currentSong = null;

            // Clear bot status for stuck tracks
            updateBotStatus(null, 'online');

            // Clear voice channel status for stuck tracks
            updateVoiceChannelStatus(guildId, null);

            broadcastMusicUpdate(guildId, musicQueue, wss, 'track_stuck');

            // Skip to next song
            setTimeout(() => {
                playNextSong(guildId, wss, true); // Skip intro for stuck track recovery
            }, 1000);
        });

        // Handle player disconnections
        lavalinkManager.on('playerDestroy', (player) => {
            const guildId = player.guildId;
            const musicQueue = getMusicQueue(guildId);

            console.log(`Player destroyed for guild ${guildId}`);

            // Clear inactivity timer when player is destroyed
            clearInactivityTimer(guildId);

            musicQueue.isPlaying = false;
            musicQueue.currentSong = null;

            // Clear bot status when player is destroyed
            updateBotStatus(null, 'online');

            // Clear voice channel status when player is destroyed
            updateVoiceChannelStatus(guildId, null);

            broadcastMusicUpdate(guildId, musicQueue, wss, 'player_destroy');
        });

        // Add periodic state synchronization to prevent drift
        setInterval(() => {
            if (lavalinkManager && lavalinkManager.players) {
                lavalinkManager.players.forEach((player, guildId) => {
                    if (player && player.connected) {
                        const musicQueue = getMusicQueue(guildId);
                        const actualIsPlaying = !player.paused && player.queue && player.queue.current;
                        const hasCurrentTrack = player.queue && player.queue.current;

                        let stateChanged = false;

                        // Only sync if there's actually a track playing and we're not in a transition state
                        if (hasCurrentTrack && musicQueue.isPlaying !== actualIsPlaying) {
                            // Don't sync if we recently reset the state (avoid interfering with song transitions)
                            const timeSinceLastUpdate = Date.now() - (musicQueue.lastUpdateTime || 0);
                            if (timeSinceLastUpdate > 10000) { // Wait 10 seconds after last update
                                console.log(`State sync: Correcting guild ${guildId} playing state - was ${musicQueue.isPlaying}, now ${actualIsPlaying}`);
                                musicQueue.isPlaying = actualIsPlaying;
                                stateChanged = true;
                            }
                        }

                        // Sync current song only if we definitely have a track and no current song
                        if (hasCurrentTrack && !musicQueue.currentSong && actualIsPlaying) {
                            const timeSinceLastUpdate = Date.now() - (musicQueue.lastUpdateTime || 0);
                            if (timeSinceLastUpdate > 10000) { // Wait 10 seconds after last update
                                const currentTrack = player.queue.current;
                                const trackDuration = getTrackDuration(currentTrack);
                                console.log(`State sync: Restoring missing current song for guild ${guildId}: ${currentTrack.info.title}`);
                                // Try to get original requester from track metadata first
                                let requestedBy = 'Unknown User';
                                if (currentTrack.originalRequester) {
                                    requestedBy = currentTrack.originalRequester;
                                } else if (currentTrack.info && currentTrack.info.originalRequester) {
                                    requestedBy = currentTrack.info.originalRequester;
                                } else if (currentTrack.requester?.originalRequester) {
                                    requestedBy = currentTrack.requester.originalRequester;
                                } else if (currentTrack.requester?.tag) {
                                    requestedBy = currentTrack.requester.tag;
                                } else if (currentTrack.requester?.username) {
                                    requestedBy = currentTrack.requester.username;
                                }
                                
                                musicQueue.currentSong = {
                                    title: currentTrack.info.title,
                                    url: currentTrack.info.uri,
                                    duration: Math.floor(trackDuration / 1000),
                                    formattedDuration: formatDuration(trackDuration),
                                    thumbnail: currentTrack.info.artworkUrl || currentTrack.info.artwork || null,
                                    requestedBy: requestedBy
                                };

                                // Update bot status for restored song
                                updateBotStatus(`🎵 ${currentTrack.info.title}`);
                                stateChanged = true;
                            }
                        }

                        // Clear current song if no track is playing - but only if not in a timer
                        if (!hasCurrentTrack && musicQueue.currentSong && !actualIsPlaying && !musicQueue.inactivityTimer) {
                            const timeSinceLastUpdate = Date.now() - (musicQueue.lastUpdateTime || 0);
                            if (timeSinceLastUpdate > 10000) { // Wait 10 seconds after last update
                                console.log(`State sync: Clearing orphaned current song for guild ${guildId}`);
                                musicQueue.currentSong = null;
                                musicQueue.isPlaying = false;

                                // Clear statuses and start inactivity timer if no songs in queue
                                if (musicQueue.queue.length === 0) {
                                    updateBotStatus(null, 'online');
                                    updateVoiceChannelStatus(guildId, null);
                                    console.log('State sync: Starting inactivity timer due to no current song and empty queue');
                                    startInactivityTimer(guildId, wss);
                                }

                                stateChanged = true;
                            }
                        }

                        // Broadcast if there were any changes, but mark the update time
                        if (stateChanged) {
                            musicQueue.lastUpdateTime = Date.now();
                            broadcastMusicUpdate(guildId, musicQueue, wss, 'state_sync');
                        }
                    }
                });
            }
        }, 10000); // Check every 10 seconds (increased interval to reduce interference)

        // Handle player disconnections
        lavalinkManager.on('playerDisconnect', (player, voiceChannel) => {
            const guildId = player.guildId;
            console.log(`Player disconnected from voice channel in guild ${guildId}`);

            // Try to reconnect after a short delay
            setTimeout(async () => {
                try {
                    if (player && !player.connected) {
                        console.log(`Attempting to reconnect player in guild ${guildId}`);
                        await player.connect();
                    }
                } catch (error) {
                    console.error('Failed to reconnect player:', error);
                }
            }, 2000);
        });

        // Initialize the manager
        await lavalinkManager.init();

        console.log('Lavalink manager initialized successfully');
    } catch (error) {
        console.error('Failed to initialize Lavalink:', error.message);
    }
}

// Play intro audio when first connecting to voice channel
async function playIntroAudio(player, guildId) {
    try {
        console.log(`Playing intro audio for guild ${guildId}`);
        
        const client = require('../config/discord');
        
        // Search for intro audio file using the hosted URL
        const nodes = lavalinkManager.nodeManager.nodes;
        if (nodes.size === 0) {
            console.log('No Lavalink nodes available for intro search');
            return false;
        }

        const firstNode = Array.from(nodes.values())[0];
        const introResult = await firstNode.search({
            query: 'http://104.248.32.109:5566/intro.mp3'
        }, client.user);

        if (!introResult || !introResult.tracks || introResult.tracks.length === 0) {
            console.log('No intro audio file found at hosted URL, skipping intro');
            return false;
        }

        const introTrack = introResult.tracks[0];
        console.log(`Found intro track: ${introTrack.info.title} (${introTrack.info.length}ms)`);
        
        // Play intro track
        await player.queue.add(introTrack);
        if (!player.playing) {
            await player.play();
        }
        
        console.log(`Intro audio started for guild ${guildId}`);
        
        // Wait for intro to finish
        return new Promise((resolve) => {
            const checkIntroEnd = () => {
                if (!player.queue.current || player.queue.current.info.uri !== introTrack.info.uri) {
                    console.log(`Intro finished for guild ${guildId}`);
                    resolve(true);
                } else {
                    setTimeout(checkIntroEnd, 500);
                }
            };
            
            // Start checking after a short delay
            setTimeout(checkIntroEnd, 1000);
        });
        
    } catch (error) {
        console.error('Error playing intro audio:', error);
        return false;
    }
}

// Music helper functions using lavalink-client
async function playNextSong(guildId, wss, skipIntro = false) {
    const musicQueue = getMusicQueue(guildId);

    // Clear any existing inactivity timer since we're about to play music
    clearInactivityTimer(guildId);

    if (musicQueue.queue.length === 0) {
        console.log(`No songs in queue for guild ${guildId}`);

        // Check if a song is currently playing before destroying
        if (lavalinkManager) {
            const existingPlayer = lavalinkManager.getPlayer(guildId);
            if (existingPlayer && existingPlayer.connected) {
                // Check if there's a current track playing
                const hasCurrentTrack = existingPlayer.queue && existingPlayer.queue.current;
                const isActuallyPlaying = !existingPlayer.paused && hasCurrentTrack;

                if (isActuallyPlaying) {
                    console.log(`Song is currently playing in guild ${guildId}, not destroying player`);
                    // Don't destroy - let the current song continue
                    musicQueue.isPlaying = true;
                    if (!musicQueue.currentSong && hasCurrentTrack) {
                        const currentTrack = existingPlayer.queue.current;
                        // Try to get original requester from track metadata first
                        let requestedBy = 'Unknown User';
                        if (currentTrack.originalRequester) {
                            requestedBy = currentTrack.originalRequester;
                        } else if (currentTrack.info && currentTrack.info.originalRequester) {
                            requestedBy = currentTrack.info.originalRequester;
                        } else if (currentTrack.requester?.originalRequester) {
                            requestedBy = currentTrack.requester.originalRequester;
                        } else if (currentTrack.requester?.tag) {
                            requestedBy = currentTrack.requester.tag;
                        } else if (currentTrack.requester?.username) {
                            requestedBy = `${currentTrack.requester.username}#${currentTrack.requester.discriminator || '0000'}`;
                        }
                        
                        musicQueue.currentSong = {
                            title: currentTrack.info.title,
                            url: currentTrack.info.uri,
                            duration: Math.floor(currentTrack.info.length / 1000),
                            thumbnail: currentTrack.info.artworkUrl,
                            requestedBy: requestedBy
                        };
                    }
                    broadcastMusicUpdate(guildId, musicQueue, wss, 'track_start');
                    return;
                }

                // No current track, safe to destroy
                try {
                    await existingPlayer.destroy();
                    console.log(`Destroyed player for guild ${guildId} - no songs to play`);
                } catch (destroyError) {
                    console.log('Player already destroyed or error destroying:', destroyError.message);
                }
            }
        }

        musicQueue.isPlaying = false;
        musicQueue.currentSong = null;
        broadcastMusicUpdate(guildId, musicQueue, wss, 'queue_empty');
        return;
    }

    if (!lavalinkManager) {
        console.error('Lavalink manager not initialized');
        return;
    }

    const song = musicQueue.queue.shift();

    try {
        const client = require('../config/discord');

        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            console.error(`Guild ${guildId} not found`);
            return;
        }

        const channel = guild.channels.cache.get(musicQueue.voiceChannel);
        if (!channel) {
            console.error(`Voice channel ${musicQueue.voiceChannel} not found`);
            return;
        }

        // Ensure the voice channel is still valid
        if (!channel || !channel.joinable) {
            console.error(`Voice channel ${musicQueue.voiceChannel} is not joinable in guild ${guildId}`);
            throw new Error('Voice channel is not accessible or joinable');
        }

        // Get or create player
        let player = lavalinkManager.getPlayer(guildId);
        if (!player) {
            console.log(`Creating new player for guild ${guildId}`);
            player = lavalinkManager.createPlayer({
                guildId: guildId,
                voiceChannelId: musicQueue.voiceChannel,
                textChannelId: musicQueue.textChannel,
                volume: musicQueue.volume,
                selfMute: false,
                selfDeaf: true
            });
        } else {
            // Update player channel if it changed
            if (player.voiceChannelId !== musicQueue.voiceChannel) {
                console.log(`Updating player voice channel from ${player.voiceChannelId} to ${musicQueue.voiceChannel}`);
                player.voiceChannelId = musicQueue.voiceChannel;
            }
        }

        // Connect to voice channel if not connected
        const wasNotConnected = !player.connected;
        if (!player.connected) {
            console.log(`Connecting to voice channel ${musicQueue.voiceChannel} in guild ${guildId}`);

            let connectionAttempts = 0;
            const maxAttempts = 3;

            while (!player.connected && connectionAttempts < maxAttempts) {
                try {
                    await player.connect();

                    // Wait for connection to stabilize
                    await new Promise(resolve => setTimeout(resolve, 2000));

                    if (player.connected) {
                        console.log(`Successfully connected to voice channel after ${connectionAttempts + 1} attempts`);
                        break;
                    }
                } catch (connectError) {
                    console.error(`Connection attempt ${connectionAttempts + 1} failed:`, connectError.message);
                }

                connectionAttempts++;

                if (connectionAttempts < maxAttempts) {
                    console.log(`Retrying connection in 2 seconds...`);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        }

        // Verify connection before proceeding
        if (!player.connected) {
            console.error(`Failed to connect to voice channel in guild ${guildId} after ${maxAttempts || 1} attempts`);
            throw new Error('Failed to connect to voice channel');
        }

        // Set volume
        await player.setVolume(musicQueue.volume);

        // Play intro audio if this is a fresh connection and we haven't skipped intro
        if (wasNotConnected && !skipIntro) {
            console.log(`Playing intro audio before starting music in guild ${guildId}`);
            
            // Clear player queue first
            if (player.queue && typeof player.queue.clear === 'function') {
                player.queue.clear();
            } else if (player.queue && player.queue.tracks && Array.isArray(player.queue.tracks)) {
                player.queue.tracks.length = 0;
            } else if (player.queue && player.queue.length !== undefined) {
                while (player.queue.length > 0) {
                    try {
                        player.queue.splice(0, 1);
                    } catch (e) {
                        break;
                    }
                }
            }

            // Play intro and wait for it to finish
            const introPlayed = await playIntroAudio(player, guildId);
            
            if (introPlayed) {
                console.log(`Intro finished, now starting music in guild ${guildId}`);
                // Clear queue again after intro
                if (player.queue && typeof player.queue.clear === 'function') {
                    player.queue.clear();
                }
            }
        } else {
            // Clear player queue and add current song normally
            if (player.queue && typeof player.queue.clear === 'function') {
                player.queue.clear();
            } else if (player.queue && player.queue.tracks && Array.isArray(player.queue.tracks)) {
                // For lavalink-client with tracks array
                player.queue.tracks.length = 0;
            } else if (player.queue && player.queue.length !== undefined) {
                // For other queue implementations
                while (player.queue.length > 0) {
                    try {
                        player.queue.splice(0, 1);
                    } catch (e) {
                        break;
                    }
                }
            }
        }

        await player.queue.add(song.track);

        // Add remaining songs to the player queue
        if (musicQueue.queue.length > 0) {
            const remainingTracks = musicQueue.queue.map(queueSong => queueSong.track);
            await player.queue.add(remainingTracks);
            console.log(`Added ${remainingTracks.length} additional tracks to Lavalink queue`);

            // Clear the app queue only after successfully adding to Lavalink
            musicQueue.queue = [];
        }

        // Start playing
        if (!player.playing) {
            await player.play();
        }

        console.log(`Now playing: ${song.title} in guild ${guildId}`);
        console.log(`Player connected: ${player.connected}, Voice Channel: ${musicQueue.voiceChannel}`);
        const lavalinkQueueSize = player.queue ? (player.queue.size || player.queue.length || 0) : 0;
        console.log(`Lavalink queue size: ${lavalinkQueueSize}, App queue size: ${musicQueue.queue.length}`);

    } catch (error) {
        console.error('Error in playNextSong:', error);
        console.log(`Skipping ${song.title} - playback error`);

        musicQueue.isPlaying = false;
        musicQueue.currentSong = null;
        broadcastMusicUpdate(guildId, musicQueue, wss, 'playback_error');

        // Try next song on error
        setTimeout(() => {
            playNextSong(guildId, wss, true); // Skip intro for error recovery
        }, 1000);
    }
}

// Update voice channel status with current song
async function updateVoiceChannelStatus(guildId, status) {
    try {
        const client = require('../config/discord');
        if (!client || !client.user) {
            console.log('Discord client not ready for voice channel status update');
            return;
        }

        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            console.error(`Guild ${guildId} not found for voice channel status update`);
            return;
        }

        const musicQueue = getMusicQueue(guildId);
        if (!musicQueue.voiceChannel) {
            console.log(`No voice channel set for guild ${guildId}`);
            return;
        }

        const voiceChannel = guild.channels.cache.get(musicQueue.voiceChannel);
        if (!voiceChannel) {
            console.error(`Voice channel ${musicQueue.voiceChannel} not found in guild ${guildId}`);
            return;
        }

        // Check if bot has permission to manage channels
        const botMember = guild.members.cache.get(client.user.id);
        if (!botMember || !voiceChannel.permissionsFor(botMember).has('ManageChannels')) {
            console.log(`Bot lacks permission to update voice channel status in guild ${guildId}`);
            return;
        }

        const statusText = status || ""; // Empty string clears the status

        // Use Discord REST API to set voice channel status (works for both voice and stage channels)
        try {
            await client.rest.put(`/channels/${musicQueue.voiceChannel}/voice-status`, {
                body: { 
                    status: statusText
                }
            });
            console.log(`Updated voice channel status in guild ${guildId}: ${statusText || 'cleared'}`);
        } catch (restError) {
            // Fallback for stage channels if REST API fails
            if (voiceChannel.type === 13) { // Stage channel
                try {
                    await voiceChannel.setStatus(statusText);
                    console.log(`Updated stage channel status (fallback) in guild ${guildId}: ${statusText || 'cleared'}`);
                } catch (fallbackError) {
                    console.error(`Failed to update voice channel status (both methods) for guild ${guildId}:`, fallbackError.message);
                }
            } else {
                console.error(`Failed to update voice channel status for guild ${guildId}:`, restError.message);
            }
        }

    } catch (error) {
        console.error(`Error updating voice channel status for guild ${guildId}:`, error.message);
    }
}

function broadcastMusicUpdate(guildId, musicQueue, wss, updateType, forcePositionReset = false) {
    // Ensure we have the latest state
    const currentMusicQueue = getMusicQueue(guildId);

    const updateData = {
        type: 'music_update',
        data: {
            guildId,
            queue: currentMusicQueue.queue || [],
            currentSong: currentMusicQueue.currentSong || null,
            isPlaying: currentMusicQueue.isPlaying || false,
            volume: currentMusicQueue.volume || 50,
            updateType: updateType || 'state_sync' // Add update type
        }
    };

    // Handle position and duration
    let currentPosition = 0;
    let songDuration = 0;

    // If we're forcing a position reset (song ended, stopped, etc.), don't get position from player
    if (forcePositionReset || updateType === 'music_ended' || updateType === 'track_ended' || updateType === 'queue_empty') {
        currentPosition = 0;
        console.log(`Position reset for guild ${guildId} due to: ${updateType}`);
    } else if (lavalinkManager && currentMusicQueue.isPlaying && currentMusicQueue.currentSong) {
        const player = lavalinkManager.getPlayer(guildId);
        if (player && player.connected && player.queue && player.queue.current) {
            // Only get position if we're actually playing
            currentPosition = player.position || 0;

            // Try to get duration from current track first
            songDuration = getTrackDuration(player.queue.current);

            if (updateType !== 'state_sync') { // Don't spam logs for sync updates
                console.log(`Current track: ${player.queue.current.info.title}`);
                console.log(`Player position: ${currentPosition}ms, track duration: ${songDuration}ms`);
            }
        }
    }

    // If no duration from Lavalink player, try to get it from stored current song
    if (!songDuration && currentMusicQueue.currentSong && currentMusicQueue.currentSong.duration) {
        songDuration = currentMusicQueue.currentSong.duration * 1000; // Convert to milliseconds
        if (updateType !== 'state_sync') {
            console.log(`Using stored duration: ${songDuration}ms for ${currentMusicQueue.currentSong.title}`);
        }
    }

    // Add position and duration to all updates (convert to seconds)
    updateData.data.position = Math.floor(currentPosition / 1000);
    updateData.data.duration = Math.floor(songDuration / 1000);
    updateData.data.formattedPosition = formatDuration(currentPosition);
    updateData.data.formattedDuration = formatDuration(songDuration);

    console.log(`Broadcasting music update for guild ${guildId} (type: ${updateType}):`, {
        currentSong: updateData.data.currentSong?.title || 'None',
        isPlaying: updateData.data.isPlaying,
        queueLength: updateData.data.queue.length,
        position: updateData.data.position,
        duration: updateData.data.duration,
        forceReset: forcePositionReset,
        clientCount: wss?.clients?.size || 0
    });

    if (wss && wss.clients) {
        let sentCount = 0;
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                try {
                    client.send(JSON.stringify(updateData));
                    sentCount++;
                } catch (error) {
                    console.error('Error sending WebSocket message:', error);
                }
            }
        });

        console.log(`Sent update to ${sentCount} clients`);
    }
}

module.exports = {
    getMusicQueue,
    initializeLavalink,
    playNextSong,
    broadcastMusicUpdate,
    updateVoiceChannelStatus,
    updateBotStatus,
    formatDuration,
    getTrackDuration,
    manager: () => lavalinkManager,
    lavalinkManager: () => lavalinkManager,
    getLavalinkManager: () => lavalinkManager
};
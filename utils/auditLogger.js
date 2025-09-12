const WebSocket = require('ws');
const { sequelize } = require('../config/database');

// Initialize Models
const AuditLog = require('../models/AuditLog')(sequelize);

// Dashboard action tracking to prevent duplicate logs
const recentDashboardActions = new Map();

function trackDashboardAction(guildId, action, targetId, moderatorId) {
    const key = `${guildId}-${action}-${targetId}-${moderatorId}`;
    recentDashboardActions.set(key, Date.now());

    // Clean up old entries after 10 seconds
    setTimeout(() => {
        recentDashboardActions.delete(key);
    }, 10000);
}

function wasRecentDashboardAction(guildId, action, targetId, moderatorId = null) {
    const key = `${guildId}-${action}-${targetId}-${moderatorId}`;
    const timestamp = recentDashboardActions.get(key);

    if (timestamp) {
        const timeDiff = Date.now() - timestamp;
        return timeDiff < 5000; // Within 5 seconds
    }
    return false;
}

// Utility Functions
async function logAction(guildId, action, moderator, target, reason = null, additionalData = {}, wss = null) {
    try {
        // Determine category based on action
        let category = 'MODERATION';
        if (['MEMBER_JOIN', 'MEMBER_LEAVE', 'NICKNAME_CHANGE', 'MEMBER_UPDATE'].includes(action)) {
            category = 'MEMBER';
        } else if (['MESSAGE_DELETE', 'MESSAGE_EDIT', 'BULK_DELETE', 'MESSAGE_PIN', 'MESSAGE_UNPIN'].includes(action)) {
            category = 'MESSAGE';
        } else if (['CHANNEL_CREATE', 'CHANNEL_DELETE', 'CHANNEL_UPDATE', 'LOCK_CHANNEL', 'UNLOCK_CHANNEL', 'CHANNEL_SLOWMODE'].includes(action)) {
            category = 'CHANNEL';
        } else if (['ROLE_CREATE', 'ROLE_DELETE', 'ROLE_UPDATE', 'ROLE_ADD', 'ROLE_REMOVE'].includes(action)) {
            category = 'ROLE';
        } else if (['BOT_CONFIG_UPDATE', 'COMMAND_USED'].includes(action)) {
            category = 'CONFIG';
        } else if (['SERVER_UPDATE', 'SERVER_BOOST', 'SERVER_UNBOOST'].includes(action)) {
            category = 'SERVER';
        } else if (['VOICE_JOIN', 'VOICE_LEAVE', 'VOICE_MOVE'].includes(action)) {
            category = 'VOICE';
        } else if (['MUSIC_PLAY', 'MUSIC_SKIP', 'MUSIC_STOP', 'MUSIC_VOLUME', 'MUSIC_QUEUE_ADD', 'MUSIC_QUEUE_REMOVE'].includes(action)) {
            category = 'MUSIC';
        } else if (['LOGIN_SUCCESS', 'LOGIN_FAILED', 'PERMISSION_DENIED', 'ERROR_OCCURRED'].includes(action)) {
            category = 'SYSTEM';
        }

        const log = await AuditLog.create({
            guildId,
            action,
            category,
            moderator: moderator ? moderator.id : null,
            moderatorTag: moderator ? moderator.tag : null,
            target: target ? target.id : null,
            targetTag: target ? target.tag : null,
            reason,
            channelId: additionalData.channelId || null,
            channelName: additionalData.channelName || null,
            additionalData: additionalData.extra || null,
            timestamp: new Date()
        });

        // Broadcast to WebSocket clients
        if (wss) {
            const logData = {
                type: 'audit_log',
                data: {
                    id: log.id,
                    guildId,
                    action,
                    category,
                    moderator: moderator ? moderator.tag : 'System',
                    moderatorTag: moderator ? moderator.tag : 'System',
                    target: target ? target.tag : null,
                    targetTag: target ? target.tag : null,
                    reason,
                    channelName: additionalData.channelName || null,
                    timestamp: log.timestamp
                }
            };

            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN && client.guildId === guildId) {
                    try {
                        client.send(JSON.stringify(logData));
                    } catch (error) {
                        console.error('Error sending WebSocket message:', error);
                    }
                }
            });
        }
    } catch (error) {
        console.error('Error logging action:', error);
    }
}

module.exports = {
    logAction,
    trackDashboardAction,
    wasRecentDashboardAction,
    AuditLog
};
const express = require('express');
const router = express.Router();
const { ensureRole, ensureDjOrAdmin } = require('../middleware/auth');
const { getOrCreateGuildConfig } = require('../utils/guildUtils');
const { AuditLog, logAction, trackDashboardAction } = require('../utils/auditLogger');
const { getMusicQueue } = require('../services/musicService');
const client = require('../config/discord');

// Dashboard home
router.get('/', ensureRole, async (req, res) => {
    try {
        const specialRoleId = '1407090466293547041';
        const djRoleId = '1407300230759845970'; // DJ role ID

        const botGuilds = client.guilds.cache.map(guild => guild.id);
        const allUserGuilds = req.user.guilds.filter(guild => botGuilds.includes(guild.id));
        let userGuilds = [];

        for (const guild of allUserGuilds) {
            const botGuild = client.guilds.cache.get(guild.id);
            if (!botGuild) continue;

            try {
                const member = botGuild.members.cache.get(req.user.id) ||
                               await botGuild.members.fetch(req.user.id);

                const hasSpecialRole = member.roles.cache.has(specialRoleId);
                const hasDjRole = member.roles.cache.has(djRoleId);

                // Check Discord permissions
                const hasAdministrator = member.permissions.has('Administrator');
                const hasManageGuild = member.permissions.has('ManageGuild');
                const hasDiscordAdminPerms = hasAdministrator || hasManageGuild;

                // Allow access if user has special role, DJ role, OR Discord admin permissions
                if (hasSpecialRole || hasDjRole || hasDiscordAdminPerms) {
                    userGuilds.push(guild);
                }
            } catch (err) {
                console.error(`Failed to fetch member for guild ${guild.id}:`, err);
            }
        }

        const mutualGuilds = userGuilds.filter(guild => botGuilds.includes(guild.id));

        res.render('dashboard', {
            user: req.user,
            guilds: mutualGuilds,
            userRole: req.userRole || { hasSpecialRole: false, hasDjRole: false }
        });
    } catch (error) {
        console.error("Error in /dashboard route:", error);
        res.redirect('/');
    }
});

// Guild dashboard
router.get('/:guildId', ensureRole, async (req, res) => {
    const { guildId } = req.params;

    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild) {
        return res.status(403).render('error', {
            message: 'Access Denied',
            error: 'You do not have access to this guild.'
        });
    }

    // Only users with BOTH Access role AND Discord admin permissions can access guild dashboard
    if (!req.userRole || !req.userRole.hasAdminPermissions) {
        // If user has DJ role but not admin permissions, redirect to music player
        if (req.userRole && req.userRole.hasDjRole) {
            return res.redirect(`/dashboard/${guildId}/music`);
        }

        return res.status(403).render('error', {
            message: 'Access Denied',
            error: 'You need both the Access role AND Discord Administrator/Manage Server permissions to view guild dashboard.'
        });
    }

    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
        return res.status(404).render('error', {
            message: 'Guild Not Found',
            error: 'The specified guild could not be found.'
        });
    }

    const config = await getOrCreateGuildConfig(guildId);
    const logs = await AuditLog.findAll({
        where: { guildId },
        order: [['timestamp', 'DESC']],
        limit: 50
    });

    // Fetch members to ensure we have the latest data
    await guild.members.fetch({ limit: 1000, force: false });

    const realMemberCount = guild.members.cache.filter(member => !member.user.bot).size;
    const onlineRealMembers = guild.members.cache.filter(m => !m.user.bot && m.presence?.status !== 'offline').size;

    const guildData = {
        id: guild.id,
        name: guild.name,
        memberCount: realMemberCount,
        onlineCount: onlineRealMembers,
        channels: guild.channels.cache.filter(c => c.type === 0).map(c => ({ id: c.id, name: c.name })),
        roles: guild.roles.cache.map(r => ({ id: r.id, name: r.name }))
    };

    res.render('guild-dashboard', {
        user: req.user,
        guild: guildData,
        config,
        logs
    });
});

// Bot configuration route
router.get('/:guildId/configuration', ensureRole, async (req, res) => {
    const { guildId } = req.params;

    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild) {
        return res.status(403).render('error', {
            message: 'Access Denied',
            error: 'You do not have access to this guild.'
        });
    }

    // Only users with BOTH Access role AND Discord admin permissions can access configuration
    if (!req.userRole || !req.userRole.hasAdminPermissions) {
        return res.status(403).render('error', {
            message: 'Access Denied',
            error: 'You need both the Access role AND Discord Administrator/Manage Server permissions to view configuration.'
        });
    }

    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
        return res.status(404).render('error', {
            message: 'Guild Not Found',
            error: 'The specified guild could not be found.'
        });
    }

    try {
        const config = await getOrCreateGuildConfig(guildId);

        const guildData = {
            id: guild.id,
            name: guild.name,
            roles: guild.roles.cache.map(r => ({ id: r.id, name: r.name }))
        };

        res.render('bot-configuration', {
            user: req.user,
            guild: guildData,
            config
        });
    } catch (error) {
        console.error('Error loading configuration page:', error);
        res.status(500).render('error', {
            message: 'Server Error',
            error: 'An internal server error occurred.'
        });
    }
});

// Members management route
router.get('/:guildId/members', ensureRole, async (req, res) => {
    const { guildId } = req.params;
    const { page = 1, search = '', role = '', sort = 'newest' } = req.query;

    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild) {
        return res.status(403).render('error', {
            message: 'Access Denied',
            error: 'You do not have access to this guild.'
        });
    }

    // Only users with BOTH Access role AND Discord admin permissions can access members management
    if (!req.userRole || !req.userRole.hasAdminPermissions) {
        return res.status(403).render('error', {
            message: 'Access Denied',
            error: 'You need both the Access role AND Discord Administrator/Manage Server permissions to view members.'
        });
    }

    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
        return res.status(404).render('error', {
            message: 'Guild Not Found',
            error: 'The specified guild could not be found.'
        });
    }

    try {
        await guild.members.fetch({ limit: 1000, force: true });

        let members = Array.from(guild.members.cache.values());

        // Filter out bots first
        members = members.filter(member => !member.user.bot);

        if (search) {
            members = members.filter(member =>
                member.user.username.toLowerCase().includes(search.toLowerCase()) ||
                member.user.tag.toLowerCase().includes(search.toLowerCase()) ||
                (member.nickname && member.nickname.toLowerCase().includes(search.toLowerCase()))
            );
        }

        if (role) {
            members = members.filter(member => member.roles.cache.has(role));
        }

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

        const limit = 50;
        const offset = (page - 1) * limit;
        const totalMembers = members.length;
        const paginatedMembers = members.slice(offset, offset + limit);

        const membersData = paginatedMembers.map(member => ({
            id: member.user.id,
            username: member.user.username,
            nickname: member.nickname,
            tag: member.user.tag,
            avatar: member.user.displayAvatarURL(),
            joinedAt: member.joinedTimestamp,
            roles: member.roles.cache.filter(role => role.id !== guild.id).map(role => ({
                id: role.id,
                name: role.name,
                color: role.hexColor
            })),
            isBot: member.user.bot,
            status: member.presence?.status || 'offline'
        }));

        // Calculate real member count excluding bots
        const realMemberCount = guild.members.cache.filter(member => !member.user.bot).size;

        const guildData = {
            id: guild.id,
            name: guild.name,
            memberCount: totalMembers, // Use actual filtered member count
            totalMembers: realMemberCount, // Real member count excluding bots
            roles: guild.roles.cache.filter(role => role.id !== guild.id).map(role => ({
                id: role.id,
                name: role.name,
                color: role.hexColor
            }))
        };

        res.render('members', {
            user: req.user,
            guild: guildData,
            members: membersData,
            pagination: {
                current: page,
                total: Math.ceil(totalMembers / limit),
                hasNext: offset + limit < totalMembers,
                hasPrev: page > 1,
                totalMembers: totalMembers,
                filteredMembers: totalMembers
            },
            filters: { search, role, sort }
        });
    } catch (error) {
        console.error('Error fetching members:', error);
        res.status(500).render('error', {
            message: 'Server Error',
            error: 'Failed to fetch members.'
        });
    }
});

// Audit logs route
router.get('/:guildId/audit', ensureRole, async (req, res) => {
    const { guildId } = req.params;

    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild) {
        return res.status(403).render('error', {
            message: 'Access Denied',
            error: 'You do not have access to this guild.'
        });
    }

    // Only users with BOTH Access role AND Discord admin permissions can access audit logs
    if (!req.userRole || !req.userRole.hasAdminPermissions) {
        return res.status(403).render('error', {
            message: 'Access Denied',
            error: 'You need both the Access role AND Discord Administrator/Manage Server permissions to view audit logs.'
        });
    }

    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
        return res.status(404).render('error', {
            message: 'Guild Not Found',
            error: 'The specified guild could not be found.'
        });
    }

    try {
        const logs = await AuditLog.findAll({
            where: { guildId },
            order: [['timestamp', 'DESC']],
            limit: 100
        });

        const guildData = {
            id: guild.id,
            name: guild.name
        };

        res.render('audit-logs', {
            user: req.user,
            guild: guildData,
            logs
        });
    } catch (error) {
        console.error('Error fetching audit logs:', error);
        res.status(500).render('error', {
            message: 'Server Error',
            error: 'An internal server error occurred.'
        });
    }
});

// Music player route
router.get('/:guildId/music', ensureDjOrAdmin, async (req, res) => {
    const { guildId } = req.params;

    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild) {
        return res.status(403).render('error', {
            message: 'Access Denied',
            error: 'You do not have access to this guild.'
        });
    }

    // Check if user has DJ role or special role for music access
    if (!req.userRole || (!req.userRole.hasSpecialRole && !req.userRole.hasDjRole)) {
        return res.status(403).render('error', {
            message: 'Access Denied',
            error: 'You do not have the required role to access music features.'
        });
    }

    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
        return res.status(404).render('error', {
            message: 'Guild Not Found',
            error: 'The specified guild could not be found.'
        });
    }

    const guildData = {
        id: guild.id,
        name: guild.name,
        channels: guild.channels.cache
            .filter(c => c.type === 2) // Voice channels
            .map(c => ({ id: c.id, name: c.name }))
    };

    const musicQueue = getMusicQueue(guildId);

    res.render('music-player', {
        user: req.user,
        guild: guildData,
        queue: musicQueue.queue,
        currentSong: musicQueue.currentSong,
        isPlaying: musicQueue.isPlaying,
        volume: musicQueue.volume
    });
});

module.exports = router;
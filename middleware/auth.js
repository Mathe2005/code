const client = require('../config/discord');

// Authentication middleware
function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) {
        return next();
    }
    // Store current page for redirect after login
    if (req.method === 'GET' && !req.xhr) {
        req.session.lastPage = req.originalUrl;
    }
    res.redirect('/auth/discord');
}

// Role-based authentication middleware
async function ensureRole(req, res, next) {
    if (!req.isAuthenticated()) {
        // Store current page for redirect after login
        if (req.method === 'GET' && !req.xhr) {
            req.session.lastPage = req.originalUrl;
        }
        return res.redirect('/auth/discord');
    }

    // Define the required role IDs - USING CONSISTENT ROLE IDS
    const specialRoleId = '1407090466293547041'; // Full access role
    const djRoleId = '1407300230759845970'; // DJ role ID

    // For guild-specific routes, check if user has the required role in that guild
    const guildId = req.params.guildId;
    if (guildId) {
        const userGuild = req.user.guilds.find(g => g.id === guildId);
        if (!userGuild) {
            return res.status(403).render('error', {
                message: 'Access Denied',
                error: 'You do not have access to this guild.'
            });
        }

        // Get the bot's guild to check user's roles
        const botGuild = client.guilds.cache.get(guildId);
        if (!botGuild) {
            return res.status(403).render('error', {
                message: 'Access Denied',
                error: 'Bot is not in this guild.'
            });
        }

        // Get user's member object in this guild - avoid fetching to prevent rate limits
        let member = botGuild.members.cache.get(req.user.id);

        if (!member) {
            // Only fetch if absolutely necessary and with error handling
            try {
                member = await botGuild.members.fetch(req.user.id);
            } catch (err) {
                console.error(`Failed to fetch member ${req.user.id} in guild ${guildId}:`, err);
                return res.status(403).render('error', {
                    message: 'Access Denied',
                    error: 'You are not a member of this guild or the bot cannot verify your membership.'
                });
            }
        }

        if (!member) {
            return res.status(403).render('error', {
                message: 'Access Denied',
                error: 'You are not a member of this guild.'
            });
        }

        // Check roles - only check Discord roles, not permissions
        const hasSpecialRole = member.roles.cache.has(specialRoleId);
        const hasDjRole = member.roles.cache.has(djRoleId);
        const hasDiscordAdminPerms = member.permissions.has('Administrator') || member.permissions.has('ManageGuild');


        // Store user's role info in request for later use
        req.userRole = {
            hasSpecialRole,
            hasDjRole,
            hasAdminPermissions: hasSpecialRole && hasDiscordAdminPerms // Need BOTH Access role AND Discord admin permissions
        };

        // Check if user has special role OR Discord Admin permissions - they get full access
        if (hasSpecialRole || hasDiscordAdminPerms) {
            return next();
        }

        // Check if user has DJ role - they only get access to music features
        if (hasDjRole) {
            // For DJ role users, only allow access to music routes
            const requestPath = req.originalUrl || req.path;
            if (requestPath.includes('/music')) {
                return next();
            } else {
                // Redirect DJ role users to music player instead of showing error
                return res.redirect(`/dashboard/${guildId}/music`);
            }
        }

        // No valid role or permissions found
        return res.status(403).render('error', {
            message: 'Access Denied',
            error: 'You do not have the required role or permissions to access this dashboard.'
        });
    } else {
        // For general dashboard access, check if user has the required role in any mutual guild
        const userGuilds = req.user.guilds || [];
        const botGuilds = client.guilds.cache.map(guild => guild.id);
        let hasSpecialRole = false;
        let hasDjRole = false;
        let hasDiscordAdminPerms = false;

        // Check for special or DJ roles/permissions in bot guilds only - avoid excessive fetching
        for (const guild of userGuilds) {
            if (!botGuilds.includes(guild.id)) continue;

            const botGuild = client.guilds.cache.get(guild.id);
            if (!botGuild) continue;

            let member = botGuild.members.cache.get(req.user.id);

            if (!member) {
                try {
                    // Only fetch if we haven't found roles/permissions yet and this is important
                    if (!hasSpecialRole && !hasDjRole && !hasDiscordAdminPerms) {
                        member = await botGuild.members.fetch(req.user.id);
                    } else {
                        continue; // Skip if we already found necessary roles/permissions
                    }
                } catch (err) {
                    console.error(`Failed to fetch member ${req.user.id} in guild ${guild.id} for general access check:`, err);
                    continue;
                }
            }

            if (member) {
                if (member.roles.cache.has(specialRoleId)) {
                    hasSpecialRole = true;
                }
                if (member.roles.cache.has(djRoleId)) {
                    hasDjRole = true;
                }
                if (member.permissions.has('Administrator') || member.permissions.has('ManageGuild')) {
                    hasDiscordAdminPerms = true;
                }
            }

            // If we have any of the required roles/permissions, we can stop checking other guilds
            if (hasSpecialRole || hasDjRole || hasDiscordAdminPerms) {
                break;
            }
        }

        // Store user's role info
        req.userRole = {
            hasSpecialRole,
            hasDjRole,
            hasAdminPermissions: hasSpecialRole && hasDiscordAdminPerms // Need BOTH Access role AND Discord admin permissions
        };

        // Allow access if user has special role, DJ role, or Discord Admin permissions
        if (hasSpecialRole || hasDjRole || hasDiscordAdminPerms) {
            return next();
        }

        return res.status(403).render('error', {
            message: 'Access Denied',
            error: 'You do not have the required role or permissions in any server where the bot is present.'
        });
    }
}

// DJ role middleware - allows both DJ role and special role to access music player
async function ensureDjOrAdmin(req, res, next) {
    if (!req.isAuthenticated()) {
        if (req.method === 'GET' && !req.xhr) {
            req.session.lastPage = req.originalUrl;
        }
        return res.redirect('/auth/discord');
    }

    // USING CONSISTENT ROLE IDS
    const specialRoleId = '1407090466293547041'; // Full access role
    const djRoleId = '1407300230759845970'; // DJ role ID
    const guildId = req.params.guildId;

    if (guildId) {
        const botGuild = client.guilds.cache.get(guildId);
        if (!botGuild) {
            return res.status(403).render('error', {
                message: 'Access Denied',
                error: 'Bot is not in this guild.'
            });
        }

        let member = botGuild.members.cache.get(req.user.id);

        if (!member) {
            try {
                member = await botGuild.members.fetch(req.user.id);
            } catch (err) {
                console.error(`Failed to fetch member ${req.user.id} in guild ${guildId}:`, err);
                return res.status(403).render('error', {
                    message: 'Access Denied',
                    error: 'Could not verify your roles.'
                });
            }
        }

        if (!member) {
            return res.status(403).render('error', {
                message: 'Access Denied',
                error: 'You are not a member of this guild.'
            });
        }

        const hasSpecialRole = member.roles.cache.has(specialRoleId);
        const hasDjRole = member.roles.cache.has(djRoleId);
        const hasDiscordAdminPerms = member.permissions.has('Administrator') || member.permissions.has('ManageGuild');


        // Store role info for use in routes
        req.userRole = {
            hasSpecialRole,
            hasDjRole,
            hasAdminPermissions: hasSpecialRole && hasDiscordAdminPerms // Need BOTH Access role AND Discord admin permissions
        };

        // Allow access if user has either special role, DJ role, OR Discord Admin permissions
        if (hasSpecialRole || hasDjRole || hasDiscordAdminPerms) {
            return next();
        }

        return res.status(403).render('error', {
            message: 'Access Denied',
            error: 'You need DJ role, special access role, or administrator permissions to access music player.'
        });
    }

    return res.status(403).render('error', {
        message: 'Access Denied',
        error: 'Guild ID required.'
    });
}

module.exports = {
    ensureAuthenticated,
    ensureRole,
    ensureDjOrAdmin
};
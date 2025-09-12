const { sequelize, CustomNickname } = require('../config/database');
const GuildConfig = require('../models/GuildConfig')(sequelize);

async function getOrCreateGuildConfig(guildId) {
    try {
        let config = await GuildConfig.findOne({ where: { guildId } });
        if (!config) {
            // Check again to prevent race conditions
            config = await GuildConfig.findOne({ where: { guildId } });
            if (!config) {
                config = await GuildConfig.create({ guildId });
            }
        }
        return config;
    } catch (error) {
        console.error('Error getting/creating guild config:', error);
        // If it's a duplicate entry error, try to find the existing one
        if (error.name === 'SequelizeUniqueConstraintError') {
            return await GuildConfig.findOne({ where: { guildId } });
        }
        return null;
    }
}

async function updateMemberNickname(member) {
    try {
        // Get guild configuration
        const config = await getOrCreateGuildConfig(member.guild.id);
        if (!config || !config.roleConfigs) {
            return;
        }

        // Parse roleConfigs if it's a string
        let roleConfigs = config.roleConfigs;
        if (typeof roleConfigs === 'string') {
            try {
                roleConfigs = JSON.parse(roleConfigs);
            } catch (parseError) {
                console.error('Error parsing roleConfigs JSON:', parseError);
                return;
            }
        }

        if (!Array.isArray(roleConfigs) || roleConfigs.length === 0) {
            return;
        }

        const specialSuffix = config.specialSuffix || '𝓗𝓮𝓷𝓷𝓮𝓼𝓼𝔂';

        // Find the highest priority role configuration (based on role position)
        let highestRoleConfig = null;
        let highestPosition = -1;
        let hasConfiguredRole = false;

        for (const roleConfig of roleConfigs) {
            if (!roleConfig.roleId) continue;

            const role = member.guild.roles.cache.get(roleConfig.roleId);
            if (!role) {
                continue;
            }

            if (!member.roles.cache.has(roleConfig.roleId)) {
                continue;
            }

            // Only consider this a "configured role" if it actually has meaningful configuration
            // Check if role has a symbol (not empty/whitespace only)
            const hasSymbol = roleConfig.symbol && typeof roleConfig.symbol === 'string' && roleConfig.symbol.trim() !== '';

            // Check if role has special suffix enabled (convert string to boolean properly)
            const hasSpecial = roleConfig.applySpecial === true || roleConfig.applySpecial === 'true' || roleConfig.applySpecial === 'Yes';

            // Skip roles that have no meaningful configuration
            if (!hasSymbol && !hasSpecial) {
                continue;
            }

            // Mark that we found at least one actually configured role
            hasConfiguredRole = true;

            if (role.position > highestPosition) {
                highestPosition = role.position;
                highestRoleConfig = roleConfig;
            }
        }

        // If no configured roles found, check for custom nickname or reset to default
        if (!hasConfiguredRole) {
            // Check for stored custom nickname first
            const customNickname = await getCustomNickname(member.user.id, member.guild.id);
            
            const currentNickname = member.nickname || member.user.username;
            const targetNickname = customNickname || member.user.username;

            // Only update if current nickname is different from target nickname
            if (currentNickname !== targetNickname) {
                if (member.id === member.guild.ownerId) {
                    return;
                }

                const botMember = member.guild.members.me;
                if (member.roles.highest.position >= botMember.roles.highest.position && member.id !== member.guild.ownerId) {
                    return;
                }

                // Set to custom nickname or reset to default username
                await member.setNickname(customNickname);
            }
            return;
        }

        // Build the new nickname with Discord's 32 character limit in mind
        let newNickname = '';
        // Use stored custom nickname if available, otherwise fall back to Discord username
        const customNickname = await getCustomNickname(member.user.id, member.guild.id);
        const baseUsername = customNickname || member.user.username;

        if (highestRoleConfig) {
            const role = member.guild.roles.cache.get(highestRoleConfig.roleId);

            let components = [];

            // Add symbol if configured
            if (highestRoleConfig.symbol && highestRoleConfig.symbol.trim()) {
                components.push(highestRoleConfig.symbol.trim());
            }

            // Add username (we'll truncate this if needed)
            let usernameToUse = baseUsername;

            // Calculate space needed for other components
            let otherComponentsLength = 0;
            if (components.length > 0) {
                otherComponentsLength += components.join(' ').length + 1; // +1 for space before username
            }

            if (highestRoleConfig.applySpecial) {
                otherComponentsLength += specialSuffix.length + 1; // +1 for space before suffix
            }

            // Truncate username if necessary to fit within 32 characters
            const maxUsernameLength = 32 - otherComponentsLength;
            if (maxUsernameLength < baseUsername.length && maxUsernameLength > 0) {
                usernameToUse = baseUsername.substring(0, Math.max(1, maxUsernameLength));
            }

            components.push(usernameToUse);

            // Add special suffix if configured and there's space
            const shouldApplySpecial = highestRoleConfig.applySpecial === true || 
                                     highestRoleConfig.applySpecial === 'true' || 
                                     highestRoleConfig.applySpecial === 'Yes';

            if (shouldApplySpecial) {
                const currentLength = components.join(' ').length;
                if (currentLength + 1 + specialSuffix.length <= 32) {
                    components.push(specialSuffix);
                }
            }

            newNickname = components.join(' ');
        }

        // Ensure it's within Discord's limits (32 characters)
        if (newNickname.length > 32) {
            newNickname = newNickname.substring(0, 32);
        }

        // Only update if the nickname would change and we have a valid new nickname
        const currentNickname = member.nickname || member.user.username;

        if (newNickname && currentNickname !== newNickname) {
            // Additional check for server owner - bots can't change owner nicknames
            if (member.id === member.guild.ownerId) {
                return;
            }

            // Check if bot has permission to change this member's nickname
            const botMember = member.guild.members.me;
            if (member.roles.highest.position >= botMember.roles.highest.position && member.id !== member.guild.ownerId) {
                return;
            }

            await member.setNickname(newNickname);
        } else if (!newNickname) {
            return;
        } else {
            return;
        }
    } catch (error) {
        console.error('Error updating member nickname:', error);

        // If it's a permissions error, log it specifically
        if (error.code === 50013) {
            console.error(`Missing permissions to change nickname for ${member.user.tag}`);
        } else if (error.code === 50035) {
            console.error(`Invalid nickname format for ${member.user.tag}`);
        }
    }
}

async function updateCustomNickname(member, customUsername) {
    try {
        // Save the custom nickname to database first
        await saveCustomNickname(member.user.id, member.guild.id, customUsername);
        
        // Get guild configuration
        const config = await getOrCreateGuildConfig(member.guild.id);
        if (!config || !config.roleConfigs) {
            // If no role configs, just set the custom username directly
            if (member.id === member.guild.ownerId) {
                return;
            }

            const botMember = member.guild.members.me;
            if (member.roles.highest.position >= botMember.roles.highest.position && member.id !== member.guild.ownerId) {
                return;
            }

            await member.setNickname(customUsername);
            return;
        }

        // Parse roleConfigs if it's a string
        let roleConfigs = config.roleConfigs;
        if (typeof roleConfigs === 'string') {
            try {
                roleConfigs = JSON.parse(roleConfigs);
            } catch (parseError) {
                console.error('Error parsing roleConfigs JSON:', parseError);
                return;
            }
        }

        if (!Array.isArray(roleConfigs) || roleConfigs.length === 0) {
            return;
        }

        const specialSuffix = config.specialSuffix || '𝓗𝓮𝓷𝓷𝓮𝓼𝓼𝔂';

        // Find the highest priority role configuration (based on role position)
        let highestRoleConfig = null;
        let highestPosition = -1;
        let hasConfiguredRole = false;

        for (const roleConfig of roleConfigs) {
            if (!roleConfig.roleId) continue;

            const role = member.guild.roles.cache.get(roleConfig.roleId);
            if (!role) {
                continue;
            }

            if (!member.roles.cache.has(roleConfig.roleId)) {
                continue;
            }

            // Only consider this a "configured role" if it actually has meaningful configuration
            const hasSymbol = roleConfig.symbol && typeof roleConfig.symbol === 'string' && roleConfig.symbol.trim() !== '';
            const hasSpecial = roleConfig.applySpecial === true || roleConfig.applySpecial === 'true' || roleConfig.applySpecial === 'Yes';

            // Skip roles that have no meaningful configuration
            if (!hasSymbol && !hasSpecial) {
                continue;
            }

            // Mark that we found at least one actually configured role
            hasConfiguredRole = true;

            if (role.position > highestPosition) {
                highestPosition = role.position;
                highestRoleConfig = roleConfig;
            }
        }

        // If no configured roles found, just set the custom username
        if (!hasConfiguredRole) {
            if (member.id === member.guild.ownerId) {
                return;
            }

            const botMember = member.guild.members.me;
            if (member.roles.highest.position >= botMember.roles.highest.position && member.id !== member.guild.ownerId) {
                return;
            }

            await member.setNickname(customUsername);
            return;
        }

        // Build the new nickname with the custom username
        let newNickname = '';
        const components = [];

        if (highestRoleConfig) {
            // Add symbol if configured
            if (highestRoleConfig.symbol && highestRoleConfig.symbol.trim()) {
                components.push(highestRoleConfig.symbol.trim());
            }

            // Add custom username
            let usernameToUse = customUsername;

            // Calculate space needed for other components
            let otherComponentsLength = 0;
            if (components.length > 0) {
                otherComponentsLength += components.join(' ').length + 1; // +1 for space before username
            }

            if (highestRoleConfig.applySpecial) {
                otherComponentsLength += specialSuffix.length + 1; // +1 for space before suffix
            }

            // Truncate username if necessary to fit within 32 characters
            const maxUsernameLength = 32 - otherComponentsLength;
            if (maxUsernameLength < customUsername.length && maxUsernameLength > 0) {
                usernameToUse = customUsername.substring(0, Math.max(1, maxUsernameLength));
            }

            components.push(usernameToUse);

            // Add special suffix if configured and there's space
            const shouldApplySpecial = highestRoleConfig.applySpecial === true || 
                                     highestRoleConfig.applySpecial === 'true' || 
                                     highestRoleConfig.applySpecial === 'Yes';

            if (shouldApplySpecial) {
                const currentLength = components.join(' ').length;
                if (currentLength + 1 + specialSuffix.length <= 32) {
                    components.push(specialSuffix);
                }
            }

            newNickname = components.join(' ');
        }

        // Ensure it's within Discord's limits (32 characters)
        if (newNickname.length > 32) {
            newNickname = newNickname.substring(0, 32);
        }

        // Update nickname if we have a valid new nickname
        if (newNickname) {
            // Additional check for server owner - bots can't change owner nicknames
            if (member.id === member.guild.ownerId) {
                return;
            }

            // Check if bot has permission to change this member's nickname
            const botMember = member.guild.members.me;
            if (member.roles.highest.position >= botMember.roles.highest.position && member.id !== member.guild.ownerId) {
                return;
            }

            await member.setNickname(newNickname);
        }
    } catch (error) {
        console.error('Error updating custom nickname:', error);

        // If it's a permissions error, log it specifically
        if (error.code === 50013) {
            console.error(`Missing permissions to change nickname for ${member.user.tag}`);
        } else if (error.code === 50035) {
            console.error(`Invalid nickname format for ${member.user.tag}`);
        }
        throw error;
    }
}

// Save custom nickname to database
async function saveCustomNickname(userId, guildId, nickname) {
    try {
        await CustomNickname.upsert({
            userId,
            guildId,
            customNickname: nickname
        });
        console.log(`Saved custom nickname for user ${userId} in guild ${guildId}: ${nickname}`);
    } catch (error) {
        console.error('Error saving custom nickname:', error);
        throw error;
    }
}

// Get custom nickname from database
async function getCustomNickname(userId, guildId) {
    try {
        const record = await CustomNickname.findOne({
            where: { userId, guildId }
        });
        return record ? record.customNickname : null;
    } catch (error) {
        console.error('Error getting custom nickname:', error);
        return null;
    }
}

// Delete custom nickname from database
async function deleteCustomNickname(userId, guildId) {
    try {
        await CustomNickname.destroy({
            where: { userId, guildId }
        });
        console.log(`Deleted custom nickname for user ${userId} in guild ${guildId}`);
    } catch (error) {
        console.error('Error deleting custom nickname:', error);
    }
}

// Update all members with configured roles when configuration changes
async function updateAllMembersWithConfiguredRoles(guild, roleConfigs) {
    try {
        if (!Array.isArray(roleConfigs) || roleConfigs.length === 0) {
            return;
        }

        // Get all role IDs that have meaningful configuration
        const configuredRoleIds = roleConfigs.filter(roleConfig => {
            const hasSymbol = roleConfig.symbol && typeof roleConfig.symbol === 'string' && roleConfig.symbol.trim() !== '';
            const hasSpecial = roleConfig.applySpecial === true || roleConfig.applySpecial === 'true' || roleConfig.applySpecial === 'Yes';
            return roleConfig.roleId && (hasSymbol || hasSpecial);
        }).map(rc => rc.roleId);

        if (configuredRoleIds.length === 0) {
            return;
        }

        // Get all members who have any of the configured roles
        const membersToUpdate = new Set();
        
        for (const roleId of configuredRoleIds) {
            const role = guild.roles.cache.get(roleId);
            if (role) {
                role.members.forEach(member => {
                    if (!member.user.bot) {
                        membersToUpdate.add(member);
                    }
                });
            }
        }

        console.log(`Updating nicknames for ${membersToUpdate.size} members with configured roles...`);

        // Update nicknames for all affected members with a small delay between each to avoid rate limits
        let updateCount = 0;
        for (const member of membersToUpdate) {
            try {
                await updateMemberNickname(member);
                updateCount++;
                
                // Add a small delay to avoid hitting Discord rate limits
                if (updateCount % 5 === 0) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            } catch (error) {
                console.error(`Error updating nickname for ${member.user.tag}:`, error);
            }
        }

        console.log(`Successfully updated ${updateCount} member nicknames.`);
    } catch (error) {
        console.error('Error updating all members with configured roles:', error);
    }
}

module.exports = {
    getOrCreateGuildConfig,
    updateMemberNickname,
    updateCustomNickname,
    updateAllMembersWithConfiguredRoles,
    saveCustomNickname,
    getCustomNickname,
    deleteCustomNickname
};
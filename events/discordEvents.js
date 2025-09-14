const Discord = require('discord.js');
const { logAction, wasRecentDashboardAction } = require('../utils/auditLogger');
const { updateMemberNickname } = require('../utils/guildUtils');

function setupDiscordEvents(client, wss) {
    client.on('clientReady', async () => {
        console.log(`Bot logged in as ${client.user.tag}!`);

        // Wait a moment for client to be fully ready
        const { initializeLavalink } = require('../services/musicService');
        setTimeout(async () => {
            await initializeLavalink(client, wss);
        }, 2000);
    });

    // Handle voice state updates for lavalink-client
    client.on('raw', (d) => {
        const { getLavalinkManager } = require('../services/musicService');
        const managerInstance = getLavalinkManager();

        if (managerInstance && ['VOICE_STATE_UPDATE', 'VOICE_SERVER_UPDATE'].includes(d.t)) {
            try {
                // Use the correct method for lavalink-client voice updates
                managerInstance.sendRawData(d);
            } catch (error) {
                console.error('Error handling voice update:', error);
            }
        }
    });

    // Member Events
    client.on('guildMemberAdd', async (member) => {
        try {
            await logAction(member.guild.id, 'MEMBER_JOIN', { id: 'system', tag: 'System' }, member.user, `Member joined the server`, {}, wss);

            setTimeout(async () => {
                try {
                    await updateMemberNickname(member);
                } catch (error) {
                    console.error('Error updating member nickname on join:', error);
                }
            }, 1000);
        } catch (error) {
            console.error('Error in guildMemberAdd event:', error);
        }
    });

    client.on('guildMemberRemove', async (member) => {
        try {
            await logAction(member.guild.id, 'MEMBER_LEAVE', { id: 'system', tag: 'System' }, member.user, `Member left the server`, {}, wss);
        } catch (error) {
            console.error('Error in guildMemberRemove event:', error);
        }
    });

    client.on('guildMemberUpdate', async (oldMember, newMember) => {
        try {
            // Check for timeout changes
        if (oldMember.communicationDisabledUntil !== newMember.communicationDisabledUntil) {
            try {
                const auditLogs = await newMember.guild.fetchAuditLogs({
                    limit: 5,
                    type: Discord.AuditLogEvent.MemberUpdate
                });

                const timeoutLog = auditLogs.entries.find(entry =>
                    entry.target?.id === newMember.user.id &&
                    Date.now() - entry.createdTimestamp < 5000 &&
                    entry.changes?.find(change => change.key === 'communication_disabled_until')
                );

                if (timeoutLog) {
                    if (newMember.communicationDisabledUntil) {
                        const duration = Math.ceil((new Date(newMember.communicationDisabledUntil) - new Date()) / 60000);
                        const reason = timeoutLog.reason || 'No reason provided';
                        await logAction(newMember.guild.id, 'TIMEOUT', timeoutLog.executor, newMember.user, reason, {
                            extra: { duration: `${duration} minutes` }
                        }, wss);
                    } else {
                        const reason = timeoutLog.reason || 'No reason provided';
                        await logAction(newMember.guild.id, 'TIMEOUT_REMOVE', timeoutLog.executor, newMember.user, reason, {}, wss);
                    }
                }
            } catch (error) {
                console.error('Error checking timeout audit logs:', error);
            }
        }

        // Check for role changes
        const addedRoles = newMember.roles.cache.filter(role => !oldMember.roles.cache.has(role.id));
        const removedRoles = oldMember.roles.cache.filter(role => !newMember.roles.cache.has(role.id));

        if (addedRoles.size > 0 || removedRoles.size > 0) {
            try {
                const roleAuditLogs = await newMember.guild.fetchAuditLogs({
                    limit: 5,
                    type: Discord.AuditLogEvent.MemberRoleUpdate
                });

                const roleLog = roleAuditLogs.entries.find(entry =>
                    entry.target?.id === newMember.user.id &&
                    Date.now() - entry.createdTimestamp < 5000
                );

                const executor = roleLog ? roleLog.executor : { id: 'system', tag: 'System' };

                if (addedRoles.size > 0) {
                    if (!wasRecentDashboardAction(newMember.guild.id, 'ROLE_ADD', newMember.user.id, executor.id)) {
                        const roleNames = addedRoles.map(role => role.name).join(', ');
                        await logAction(newMember.guild.id, 'ROLE_ADD', executor, newMember.user, `Roles added: ${roleNames}`, {}, wss);
                    }

                    // Check if any added role is a configured role and send username input embed
                    const { getOrCreateGuildConfig } = require('../utils/guildUtils');
                    const config = await getOrCreateGuildConfig(newMember.guild.id);

                    if (config && config.roleConfigs) {
                        let roleConfigs = config.roleConfigs;
                        if (typeof roleConfigs === 'string') {
                            try {
                                roleConfigs = JSON.parse(roleConfigs);
                            } catch (parseError) {
                                console.error('Error parsing roleConfigs JSON:', parseError);
                                return;
                            }
                        }

                        if (Array.isArray(roleConfigs) && roleConfigs.length > 0) {
                            // Check if any added role is in the configured roles
                            const hasConfiguredRole = addedRoles.some(role => {
                                const roleConfig = roleConfigs.find(rc => rc.roleId === role.id);
                                if (!roleConfig) return false;

                                const hasSymbol = roleConfig.symbol && typeof roleConfig.symbol === 'string' && roleConfig.symbol.trim() !== '';
                                const hasSpecial = roleConfig.applySpecial === true || roleConfig.applySpecial === 'true' || roleConfig.applySpecial === 'Yes';

                                return hasSymbol || hasSpecial;
                            });

                            if (hasConfiguredRole) {
                                // Check if user already has a custom nickname set
                                const { getCustomNickname } = require('../utils/guildUtils');
                                const existingNickname = await getCustomNickname(newMember.user.id, newMember.guild.id);

                                // Only send embed if user doesn't already have a custom nickname
                                if (!existingNickname) {
                                    const embed = new Discord.EmbedBuilder()
                                        .setTitle('🎮')
                                        .setDescription('თქვენ გადმოგეცათ სპეციალური როლი დისქორდზე გთხოვთ დააჭიროთ დაბლა ღილაკს.')
                                        .setColor('#00ff00')
                                        .setFooter({ text: 'მხოლოდ წერთ თქვენს In Game სახელს სხვას არაფერს.' });

                                    const button = new Discord.ButtonBuilder()
                                        .setCustomId(`set_username_${newMember.user.id}`)
                                        .setLabel('შეიყვანეთ თქვენი სახელი')
                                        .setStyle(Discord.ButtonStyle.Primary)
                                        .setEmoji('✏️');

                                    const row = new Discord.ActionRowBuilder()
                                        .addComponents(button);

                                    try {
                                        await newMember.send({ embeds: [embed], components: [row] });
                                    } catch (error) {
                                        console.error('Could not send DM to user, trying in guild channel:', error);
                                        // If DM fails, try to send in a system channel or the first available text channel
                                        const systemChannel = newMember.guild.systemChannel || 
                                                             newMember.guild.channels.cache.find(ch => ch.type === 0 && ch.permissionsFor(newMember.guild.members.me).has('SendMessages'));

                                        if (systemChannel) {
                                            await systemChannel.send({ 
                                                content: `${newMember.user}`, 
                                                embeds: [embed], 
                                                components: [row] 
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                if (removedRoles.size > 0) {
                    if (!wasRecentDashboardAction(newMember.guild.id, 'ROLE_REMOVE', newMember.user.id, executor.id)) {
                        const roleNames = removedRoles.map(role => role.name).join(', ');
                        await logAction(newMember.guild.id, 'ROLE_REMOVE', executor, newMember.user, `Roles removed: ${roleNames}`, {}, wss);
                    }
                }

                setTimeout(async () => {
                    await updateMemberNickname(newMember);
                }, 500);
            } catch (error) {
                console.error('Error checking role audit logs:', error);
                await updateMemberNickname(newMember);
            }
        }

        // Check for nickname changes
        if (oldMember.nickname !== newMember.nickname) {
            try {
                const nicknameAuditLogs = await newMember.guild.fetchAuditLogs({
                    limit: 5,
                    type: Discord.AuditLogEvent.MemberUpdate
                });

                const nicknameLog = nicknameAuditLogs.entries.find(entry =>
                    entry.target?.id === newMember.user.id &&
                    Date.now() - entry.createdTimestamp < 5000 &&
                    entry.changes?.find(change => change.key === 'nick')
                );

                const executor = nicknameLog ? nicknameLog.executor : { id: 'system', tag: 'System' };

                if (!wasRecentDashboardAction(newMember.guild.id, 'NICKNAME_CHANGE', newMember.user.id, executor.id)) {
                    await logAction(newMember.guild.id, 'NICKNAME_CHANGE', executor, newMember.user,
                        `Nickname changed from "${oldMember.nickname || 'None'}" to "${newMember.nickname || 'None'}"`, {}, wss);
                }
            } catch (error) {
                console.error('Error checking nickname audit logs:', error);
            }
        }
        } catch (error) {
            console.error('Error in guildMemberUpdate event:', error);
        }
    });

    // Message Events
    client.on('messageDelete', async (message) => {
        try {
            if (message.author?.bot) return;
            if (!message.guild) return;

        try {
            const auditLogs = await message.guild.fetchAuditLogs({
                limit: 5,
                type: Discord.AuditLogEvent.MessageDelete
            });

            const deleteLog = auditLogs.entries.find(entry =>
                entry.target?.id === message.author?.id &&
                Date.now() - entry.createdTimestamp < 5000
            );

            const executor = deleteLog ? deleteLog.executor : { id: 'system', tag: 'System' };
            await logAction(message.guild.id, 'MESSAGE_DELETE', executor, message.author,
                `Message deleted in #${message.channel.name}: "${message.content?.substring(0, 100) || 'No content'}"`, {}, wss);
        } catch (error) {
            console.error('Error checking message delete audit logs:', error);
            await logAction(message.guild.id, 'MESSAGE_DELETE', { id: 'system', tag: 'System' }, message.author,
                `Message deleted in #${message.channel.name}: "${message.content?.substring(0, 100) || 'No content'}"`, {}, wss);
        }
        } catch (error) {
            console.error('Error in messageDelete event:', error);
        }
    });

    client.on('messageUpdate', async (oldMessage, newMessage) => {
        try {
            if (newMessage.author?.bot) return;
            if (!newMessage.guild) return;
            if (oldMessage.content === newMessage.content) return;

            await logAction(newMessage.guild.id, 'MESSAGE_EDIT', newMessage.author, newMessage.author,
                `Message edited in #${newMessage.channel.name}`, {}, wss);
        } catch (error) {
            console.error('Error in messageUpdate event:', error);
        }
    });

    client.on('messageBulkDelete', async (messages) => {
        try {
            const firstMessage = messages.first();
            if (!firstMessage?.guild) return;

        try {
            const auditLogs = await firstMessage.guild.fetchAuditLogs({
                limit: 5,
                type: Discord.AuditLogEvent.MessageBulkDelete
            });

            const bulkDeleteLog = auditLogs.entries.find(entry =>
                Date.now() - entry.createdTimestamp < 5000
            );

            const executor = bulkDeleteLog ? bulkDeleteLog.executor : { id: 'system', tag: 'System' };
            await logAction(firstMessage.guild.id, 'BULK_DELETE', executor, null,
                `${messages.size} messages bulk deleted in #${firstMessage.channel.name}`, {}, wss);
        } catch (error) {
            console.error('Error checking bulk delete audit logs:', error);
            await logAction(firstMessage.guild.id, 'BULK_DELETE', { id: 'system', tag: 'System' }, null,
                `${messages.size} messages bulk deleted in #${firstMessage.channel.name}`, {}, wss);
        }
        } catch (error) {
            console.error('Error in messageBulkDelete event:', error);
        }
    });

    // Basic message logging only
    client.on('messageCreate', async (message) => {
        try {
            if (message.author.bot) return;
            if (!message.guild) return;
            // Additional message handling can be added here if needed
        } catch (error) {
            console.error('Error in messageCreate event:', error);
        }
    });

    // Handle button interactions for username input and approval system
    client.on('interactionCreate', async (interaction) => {
        try {
            if (!interaction.isButton() && !interaction.isModalSubmit()) return;

            // Handle approval system interactions
            if (interaction.isButton() && (interaction.customId.startsWith('approve_') || interaction.customId.startsWith('decline_'))) {
                const { handleApprovalInteraction } = require('../utils/approvalSystem');
                return await handleApprovalInteraction(interaction);
            }

            if (interaction.isButton() && interaction.customId.startsWith('set_username_')) {
                const userId = interaction.customId.split('_')[2];

                // Check if the interaction user is the intended user
                if (interaction.user.id !== userId) {
                    return interaction.reply({ content: 'ეს შენთვის არაა ბიძი!', flags: Discord.MessageFlags.Ephemeral });
                }

                const modal = new Discord.ModalBuilder()
                    .setCustomId(`username_modal_${userId}`)
                    .setTitle('ჩაწერეთ თქვენი In Game სახელი');

                const usernameInput = new Discord.TextInputBuilder()
                    .setCustomId('username_input')
                    .setLabel('აქ ჩაწერეთ მხოლოდ სახელი')
                    .setStyle(Discord.TextInputStyle.Short)
                    .setMinLength(1)
                    .setMaxLength(20)
                    .setPlaceholder('...')
                    .setRequired(true);

                const firstActionRow = new Discord.ActionRowBuilder().addComponents(usernameInput);
                modal.addComponents(firstActionRow);

                await interaction.showModal(modal);
            }

            if (interaction.isModalSubmit() && interaction.customId.startsWith('username_modal_')) {
                const userId = interaction.customId.split('_')[2];

                // Check if the interaction user is the intended user
                if (interaction.user.id !== userId) {
                    return interaction.reply({ content: 'ეს შენთვის არაა ბიძი!', flags: Discord.MessageFlags.Ephemeral });
                }

                const username = interaction.fields.getTextInputValue('username_input');

                // Find the guild - if in DM, find the guild where the user has the configured role
                let guild = interaction.guild;
                let member = null;

                if (!guild) {
                    // If in DM, find the guild where this user has configured roles
                    for (const [guildId, cachedGuild] of interaction.client.guilds.cache) {
                        const guildMember = cachedGuild.members.cache.get(userId);
                        if (guildMember) {
                            const { getOrCreateGuildConfig } = require('../utils/guildUtils');
                            const config = await getOrCreateGuildConfig(guildId);

                            if (config && config.roleConfigs) {
                                let roleConfigs = config.roleConfigs;
                                if (typeof roleConfigs === 'string') {
                                    try {
                                        roleConfigs = JSON.parse(roleConfigs);
                                    } catch (parseError) {
                                        continue;
                                    }
                                }

                                if (Array.isArray(roleConfigs) && roleConfigs.length > 0) {
                                    // Check if user has any configured role in this guild
                                    const hasConfiguredRole = roleConfigs.some(roleConfig => {
                                        if (!roleConfig.roleId) return false;
                                        const hasSymbol = roleConfig.symbol && typeof roleConfig.symbol === 'string' && roleConfig.symbol.trim() !== '';
                                        const hasSpecial = roleConfig.applySpecial === true || roleConfig.applySpecial === 'true' || roleConfig.applySpecial === 'Yes';
                                        return (hasSymbol || hasSpecial) && guildMember.roles.cache.has(roleConfig.roleId);
                                    });

                                    if (hasConfiguredRole) {
                                        guild = cachedGuild;
                                        member = guildMember;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                } else {
                    member = guild.members.cache.get(userId);
                }

                if (!guild || !member) {
                    return interaction.reply({ content: 'Error: Could not find your member information in any configured guild.', flags: Discord.MessageFlags.Ephemeral });
                }

                try {
                    const { updateCustomNickname } = require('../utils/guildUtils');
                    await updateCustomNickname(member, username);

                    // Delete the original embed message if it exists
                    try {
                        if (interaction.message && interaction.message.deletable) {
                            await interaction.message.delete();
                        }
                    } catch (deleteError) {
                        console.log('Could not delete original embed message:', deleteError.message);
                    }

                    await interaction.reply({ content: `✅ Your in-game username has been set to: **${username}**`, flags: Discord.MessageFlags.Ephemeral });
                } catch (error) {
                    console.error('Error updating custom nickname:', error);
                    await interaction.reply({ content: '❌ Failed to update your nickname. Please try again or contact an administrator.', flags: Discord.MessageFlags.Ephemeral });
                }
            }
        } catch (error) {
            console.error('Error in interactionCreate event:', error);
            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: '❌ An unexpected error occurred. Please try again.', flags: Discord.MessageFlags.Ephemeral });
                }
            } catch (replyError) {
                console.error('Error sending error reply:', replyError);
            }
        }
    });

    // Ban Events
    client.on('guildBanAdd', async (ban) => {
        try {
            const auditLogs = await ban.guild.fetchAuditLogs({
                limit: 3,
                type: Discord.AuditLogEvent.MemberBanAdd
            });

            const banLog = auditLogs.entries.find(entry =>
                entry.target?.id === ban.user.id &&
                Date.now() - entry.createdTimestamp < 5000
            );

            const executor = banLog ? banLog.executor : { id: 'system', tag: 'System' };
            const reason = banLog ? banLog.reason || 'No reason provided' : 'No reason provided';
            await logAction(ban.guild.id, 'MEMBER_BAN', executor, ban.user, reason, {}, wss);
        } catch (error) {
            console.error('Error checking ban audit logs:', error);
            try {
                await logAction(ban.guild.id, 'MEMBER_BAN', { id: 'system', tag: 'System' }, ban.user, 'Member banned', {}, wss);
            } catch (logError) {
                console.error('Error logging ban action:', logError);
            }
        }
    });

    // Channel Events
    client.on('channelCreate', async (channel) => {
        try {
            if (!channel.guild) return;

            const auditLogs = await channel.guild.fetchAuditLogs({
                limit: 3,
                type: Discord.AuditLogEvent.ChannelCreate
            });

            const createLog = auditLogs.entries.find(entry =>
                entry.target?.id === channel.id &&
                Date.now() - entry.createdTimestamp < 5000
            );

            const executor = createLog ? createLog.executor : { id: 'system', tag: 'System' };
            await logAction(channel.guild.id, 'CHANNEL_CREATE', executor, null, `Channel #${channel.name} created`, {
                channelId: channel.id,
                channelName: channel.name
            }, wss);
        } catch (error) {
            console.error('Error logging channel create:', error);
        }
    });

    client.on('channelDelete', async (channel) => {
        try {
            if (!channel.guild) return;

            const auditLogs = await channel.guild.fetchAuditLogs({
                limit: 3,
                type: Discord.AuditLogEvent.ChannelDelete
            });

            const deleteLog = auditLogs.entries.find(entry =>
                entry.target?.id === channel.id &&
                Date.now() - entry.createdTimestamp < 5000
            );

            const executor = deleteLog ? deleteLog.executor : { id: 'system', tag: 'System' };
            await logAction(channel.guild.id, 'CHANNEL_DELETE', executor, null, `Channel #${channel.name} deleted`, {
                channelId: channel.id,
                channelName: channel.name
            }, wss);
        } catch (error) {
            console.error('Error logging channel delete:', error);
        }
    });

    client.on('channelUpdate', async (oldChannel, newChannel) => {
        try {
            if (!newChannel.guild) return;

            const changes = [];
            if (oldChannel.name !== newChannel.name) {
                changes.push(`Name: ${oldChannel.name} → ${newChannel.name}`);
            }
            if (oldChannel.topic !== newChannel.topic) {
                changes.push(`Topic: ${oldChannel.topic || 'None'} → ${newChannel.topic || 'None'}`);
            }

            if (changes.length > 0) {
                const auditLogs = await newChannel.guild.fetchAuditLogs({
                    limit: 3,
                    type: Discord.AuditLogEvent.ChannelUpdate
                });

                const updateLog = auditLogs.entries.find(entry =>
                    entry.target?.id === newChannel.id &&
                    Date.now() - entry.createdTimestamp < 5000
                );

                const executor = updateLog ? updateLog.executor : { id: 'system', tag: 'System' };
                await logAction(newChannel.guild.id, 'CHANNEL_UPDATE', executor, null, `Channel #${newChannel.name} updated: ${changes.join(', ')}`, {
                    channelId: newChannel.id,
                    channelName: newChannel.name
                }, wss);
            }
        } catch (error) {
            console.error('Error logging channel update:', error);
        }
    });

    // Role Events
    client.on('roleCreate', async (role) => {
        try {
            const auditLogs = await role.guild.fetchAuditLogs({
                limit: 3,
                type: Discord.AuditLogEvent.RoleCreate
            });

            const createLog = auditLogs.entries.find(entry =>
                entry.target?.id === role.id &&
                Date.now() - entry.createdTimestamp < 5000
            );

            const executor = createLog ? createLog.executor : { id: 'system', tag: 'System' };
            await logAction(role.guild.id, 'ROLE_CREATE', executor, null, `Role "${role.name}" created`, {}, wss);
        } catch (error) {
            console.error('Error logging role create:', error);
        }
    });

    client.on('roleDelete', async (role) => {
        try {
            const auditLogs = await role.guild.fetchAuditLogs({
                limit: 3,
                type: Discord.AuditLogEvent.RoleDelete
            });

            const deleteLog = auditLogs.entries.find(entry =>
                entry.target?.id === role.id &&
                Date.now() - entry.createdTimestamp < 5000
            );

            const executor = deleteLog ? deleteLog.executor : { id: 'system', tag: 'System' };
            await logAction(role.guild.id, 'ROLE_DELETE', executor, null, `Role "${role.name}" deleted`, {}, wss);
        } catch (error) {
            console.error('Error logging role delete:', error);
        }
    });

    client.on('roleUpdate', async (oldRole, newRole) => {
        try {
            const changes = [];
            if (oldRole.name !== newRole.name) {
                changes.push(`Name: ${oldRole.name} → ${newRole.name}`);
            }
            if (oldRole.color !== newRole.color) {
                changes.push(`Color changed`);
            }
            if (oldRole.permissions.bitfield !== newRole.permissions.bitfield) {
                changes.push(`Permissions updated`);
            }

            if (changes.length > 0) {
                const auditLogs = await newRole.guild.fetchAuditLogs({
                    limit: 3,
                    type: Discord.AuditLogEvent.RoleUpdate
                });

                const updateLog = auditLogs.entries.find(entry =>
                    entry.target?.id === newRole.id &&
                    Date.now() - entry.createdTimestamp < 5000
                );

                const executor = updateLog ? updateLog.executor : { id: 'system', tag: 'System' };
                await logAction(newRole.guild.id, 'ROLE_UPDATE', executor, null, `Role "${newRole.name}" updated: ${changes.join(', ')}`, {}, wss);
            }
        } catch (error) {
            console.error('Error logging role update:', error);
        }
    });

    // Voice Events
    client.on('voiceStateUpdate', async (oldState, newState) => {
        try {
            if (!newState.guild) return;

            const member = newState.member;
            if (!member || member.user.bot) return;

            if (!oldState.channelId && newState.channelId) {
                // User joined voice channel
                await logAction(newState.guild.id, 'VOICE_JOIN', member.user, member.user, `Joined voice channel: ${newState.channel.name}`, {
                    channelId: newState.channelId,
                    channelName: newState.channel.name
                }, wss);
            } else if (oldState.channelId && !newState.channelId) {
                // User left voice channel
                await logAction(newState.guild.id, 'VOICE_LEAVE', member.user, member.user, `Left voice channel: ${oldState.channel.name}`, {
                    channelId: oldState.channelId,
                    channelName: oldState.channel.name
                }, wss);
            } else if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
                // User moved between voice channels - check for moderator action
                try {
                    // Small delay to ensure audit log is available
                    await new Promise(resolve => setTimeout(resolve, 500));

                    const auditLogs = await newState.guild.fetchAuditLogs({
                        limit: 10,
                        type: Discord.AuditLogEvent.MemberMove
                    });

                    // Find the most recent audit log entry for voice moves
                    const moveLog = auditLogs.entries.find(entry => {
                        const timeDiff = Date.now() - entry.createdTimestamp;
                        const isRecent = timeDiff < 10000; // Within 10 seconds
                        const isDifferentExecutor = entry.executor.id !== member.user.id;
                        const isNotBot = !entry.executor.bot;

                        console.log(`Audit log entry: Executor: ${entry.executor.tag}, Recent: ${isRecent}, DifferentExecutor: ${isDifferentExecutor}, TimeDiff: ${timeDiff}ms`);

                        return isRecent && isDifferentExecutor && isNotBot;
                    });

                    if (moveLog) {
                        // Someone else moved a user recently - assume it was this move
                        console.log(`✅ Voice move by moderator detected: ${moveLog.executor.tag} moved ${member.user.tag} from ${oldState.channel.name} to ${newState.channel.name}`);
                        await logAction(newState.guild.id, 'VOICE_MOVE', moveLog.executor, member.user, `Moved from ${oldState.channel.name} to ${newState.channel.name}`, {
                            fromChannelId: oldState.channelId,
                            fromChannelName: oldState.channel.name,
                            toChannelId: newState.channelId,
                            toChannelName: newState.channel.name
                        }, wss);
                    } else {
                        // No recent moderator action found - user moved themselves
                        console.log(`ℹ️ User ${member.user.tag} self-moved from ${oldState.channel.name} to ${newState.channel.name}`);
                    }
                } catch (error) {
                    console.error('Error checking voice move audit logs:', error);
                }
            }
        } catch (error) {
            console.error('Error logging voice state update:', error);
        }
    });

    // Guild Events
    client.on('guildUpdate', async (oldGuild, newGuild) => {
        try {
            const changes = [];
            if (oldGuild.name !== newGuild.name) {
                changes.push(`Name: ${oldGuild.name} → ${newGuild.name}`);
            }
            if (oldGuild.description !== newGuild.description) {
                changes.push(`Description updated`);
            }

            if (changes.length > 0) {
                const auditLogs = await newGuild.fetchAuditLogs({
                    limit: 3,
                    type: Discord.AuditLogEvent.GuildUpdate
                });

                const updateLog = auditLogs.entries.first();
                const executor = updateLog ? updateLog.executor : { id: 'system', tag: 'System' };
                await logAction(newGuild.id, 'SERVER_UPDATE', executor, null, `Server updated: ${changes.join(', ')}`, {}, wss);
            }
        } catch (error) {
            console.error('Error logging guild update:', error);
        }
    });

    client.on('guildBanRemove', async (ban) => {
        try {
            const auditLogs = await ban.guild.fetchAuditLogs({
                limit: 3,
                type: Discord.AuditLogEvent.MemberBanRemove
            });

            const unbanLog = auditLogs.entries.find(entry =>
                entry.target?.id === ban.user.id &&
                Date.now() - entry.createdTimestamp < 5000
            );

            const executor = unbanLog ? unbanLog.executor : { id: 'system', tag: 'System' };
            await logAction(ban.guild.id, 'MEMBER_UNBAN', executor, ban.user, `Member unbanned`, {}, wss);
        } catch (error) {
            console.error('Error checking unban audit logs:', error);
            try {
                await logAction(ban.guild.id, 'MEMBER_UNBAN', { id: 'system', tag: 'System' }, ban.user, `Member unbanned`, {}, wss);
            } catch (logError) {
                console.error('Error logging unban action:', logError);
            }
        }
    });
}

module.exports = setupDiscordEvents;
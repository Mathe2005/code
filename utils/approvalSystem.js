const Discord = require('discord.js');
const client = require('../config/discord');

// Store pending approval requests
const pendingApprovals = new Map();

// Roles that can approve/decline requests
const APPROVAL_ROLES = ['1218176257146228827', '1347515485968793672'];

async function sendApprovalRequest(channel, requestData) {
    const { type, guildId, targetId, targetUsername, targetTag, requesterId, requesterTag, reason, deleteMessages } = requestData;

    try {
        // Get guild to fetch member info for nickname
        const guild = client.guilds.cache.get(guildId);
        let displayName = targetUsername;
        
        if (guild) {
            try {
                const targetMember = await guild.members.fetch(targetId);
                if (targetMember && targetMember.nickname) {
                    displayName = `${targetMember.nickname} (${targetUsername})`;
                }
            } catch (error) {
                // If we can't fetch the member (they left), just use username
                console.log(`Could not fetch member ${targetId} for nickname display`);
            }
        }

        const embed = new Discord.EmbedBuilder()
            .setTitle(`${type.toUpperCase()} REQUEST`)
            .setColor(type === 'ban' ? '#FF0000' : '#FFA500')
            .addFields(
                { name: 'Target User', value: `${displayName} (${targetTag})\nID: ${targetId}`, inline: true },
                { name: 'Requested By', value: `${requesterTag}\nID: ${requesterId}`, inline: true },
                { name: 'Reason', value: reason || 'No reason provided', inline: false }
            )
            .setTimestamp()
            .setFooter({ text: `Guild ID: ${guildId} | Auto-expires in 24 hours` });

        if (type === 'ban' && deleteMessages) {
            embed.addFields({ name: 'Delete Messages', value: 'Yes (7 days)', inline: true });
        }

        // Use a more stable ID generation that doesn't rely on exact timestamp matching
        const baseId = `${type}_${targetId}_${requesterId}`;
        const timestamp = Date.now();
        const approvalId = `${baseId}_${timestamp}`;

        const approveButton = new Discord.ButtonBuilder()
            .setCustomId(`approve_${approvalId}`)
            .setLabel(`Approve ${type.toUpperCase()}`)
            .setStyle(Discord.ButtonStyle.Success)
            .setEmoji('✅');

        const declineButton = new Discord.ButtonBuilder()
            .setCustomId(`decline_${approvalId}`)
            .setLabel(`Decline ${type.toUpperCase()}`)
            .setStyle(Discord.ButtonStyle.Danger)
            .setEmoji('❌');

        const row = new Discord.ActionRowBuilder()
            .addComponents(approveButton, declineButton);

        const message = await channel.send({
            embeds: [embed],
            components: [row]
        });

        // Store the approval request
        pendingApprovals.set(approvalId, {
            messageId: message.id,
            channelId: channel.id,
            guildId,
            type,
            targetId,
            targetUsername,
            targetTag,
            requesterId,
            requesterTag,
            reason,
            deleteMessages: deleteMessages || false,
            timestamp: Date.now()
        });

        // Auto-expire after 24 hours
        setTimeout(async () => {
            try {
                if (pendingApprovals.has(approvalId)) {
                    pendingApprovals.delete(approvalId);

                    // Get display name for expired message
                    const guild = client.guilds.cache.get(guildId);
                    let displayName = targetUsername;
                    
                    if (guild) {
                        try {
                            const targetMember = await guild.members.fetch(targetId);
                            if (targetMember && targetMember.nickname) {
                                displayName = `${targetMember.nickname} (${targetUsername})`;
                            }
                        } catch (error) {
                            // Member may have left, use stored username
                            console.log(`Could not fetch member ${targetId} for expired message`);
                        }
                    }

                    const expiredEmbed = new Discord.EmbedBuilder()
                        .setTitle(`${type.toUpperCase()} REQUEST EXPIRED ⏰`)
                        .setColor('#6c757d')
                        .addFields(
                            { name: 'Target User', value: `${displayName} (${targetTag})`, inline: true },
                            { name: 'Requested By', value: requesterTag, inline: true },
                            { name: 'Reason', value: reason || 'No reason provided', inline: false },
                            { name: 'Status', value: '⏰ Request expired after 24 hours', inline: false }
                        )
                        .setTimestamp()
                        .setFooter({ text: 'Request expired' });

                    await message.edit({
                        embeds: [expiredEmbed],
                        components: []
                    });

                    console.log(`Auto-expired ${type} request for ${targetTag}`);
                }
            } catch (error) {
                console.error('Error auto-expiring approval request:', error);
            }
        }, 24 * 60 * 60 * 1000); // 24 hours

        console.log(`Sent ${type} approval request for ${targetTag} to channel ${channel.name}`);
    } catch (error) {
        console.error('Error sending approval request:', error);
        throw error;
    }
}

async function handleApprovalInteraction(interaction) {
    try {
        if (!interaction.isButton()) return;

        // Check if interaction is already acknowledged/expired
        if (interaction.replied || interaction.deferred) {
            console.log('Interaction already handled, skipping');
            return;
        }

        // Immediately acknowledge the interaction to prevent timeout
        let acknowledged = false;
        try {
            await interaction.deferUpdate();
            acknowledged = true;
        } catch (error) {
            console.error('Failed to acknowledge interaction:', error.message);
            // If we can't acknowledge, the interaction is likely expired
            return;
        }

        const customIdParts = interaction.customId.split('_');
        if (customIdParts.length < 5) {
            console.error('Invalid custom ID format:', interaction.customId);
            return;
        }

        const [action, type, targetId, guildId, timestamp] = customIdParts;
        if (!['approve', 'decline'].includes(action) || !['kick', 'ban'].includes(type)) {
            console.error('Invalid action or type:', action, type);
            return;
        }

        // Check if user has permission to approve/decline
        const member = interaction.member;
        if (!member) {
            if (acknowledged) {
                return interaction.editReply({
                    content: 'Error: Could not verify your permissions.',
                    components: []
                });
            }
            return;
        }

        const hasPermission = APPROVAL_ROLES.some(roleId => member.roles.cache.has(roleId));
        if (!hasPermission) {
            if (acknowledged) {
                return interaction.editReply({
                    content: 'You do not have permission to approve/decline moderation requests.',
                    components: []
                });
            }
            return;
        }

        const approvalId = `${type}_${targetId}_${guildId}_${timestamp}`;
        
        let approvalData = pendingApprovals.get(approvalId);

        // If exact match not found, try to find by base pattern (without timestamp)
        if (!approvalData) {
            console.log(`Looking for approval ID: ${approvalId}`);
            console.log(`Available approval IDs: [`, Array.from(pendingApprovals.keys()).map(id => `'${id}'`), `]`);

            // Extract base pattern from the requested ID
            const parts = approvalId.split('_');
            if (parts.length >= 4) {
                const basePattern = `${parts[0]}_${parts[1]}_${parts[2]}_`;

                // Find approval with matching base pattern
                for (const [storedId, data] of pendingApprovals.entries()) {
                    if (storedId.startsWith(basePattern)) {
                        // Check if timestamp is within reasonable range (5 seconds)
                        const storedTimestamp = parseInt(storedId.split('_').pop());
                        const requestedTimestamp = parseInt(parts[3]);

                        if (Math.abs(storedTimestamp - requestedTimestamp) < 5000) {
                            approvalData = data;
                            // Update the map with the exact ID used in the interaction
                            pendingApprovals.delete(storedId);
                            pendingApprovals.set(approvalId, data);
                            console.log(`Found matching approval with timestamp variation: ${storedId} -> ${approvalId}`);
                            break;
                        }
                    }
                }
            }
        }

        if (!approvalData) {
            console.error(`Approval not found for ID: ${approvalId}`);
            if (acknowledged) {
                return interaction.editReply({
                    content: 'This approval request has already been processed or expired.',
                    components: []
                });
            }
            return;
        }

        if (action === 'approve') {
            // Execute the kick/ban
            const success = await executeModeration(approvalData, interaction.user);

            if (success) {
                // Remove from pending approvals after successful execution
                pendingApprovals.delete(approvalId);

                // Get display name for completion message
                const guild = client.guilds.cache.get(approvalData.guildId);
                let displayName = approvalData.targetUsername;
                
                if (guild) {
                    try {
                        const targetMember = await guild.members.fetch(approvalData.targetId);
                        if (targetMember && targetMember.nickname) {
                            displayName = `${targetMember.nickname} (${approvalData.targetUsername})`;
                        }
                    } catch (error) {
                        // Member may have left, use stored username
                        console.log(`Could not fetch member ${approvalData.targetId} for completion message`);
                    }
                }

                const embed = new Discord.EmbedBuilder()
                    .setTitle(`${type.toUpperCase()} APPROVED & EXECUTED ✅`)
                    .setColor('#00FF00')
                    .addFields(
                        { name: 'Target User', value: `${displayName} (${approvalData.targetTag})`, inline: true },
                        { name: 'Requested By', value: approvalData.requesterTag, inline: true },
                        { name: 'Approved By', value: `${interaction.user.username}#${interaction.user.discriminator}`, inline: true },
                        { name: 'Reason', value: approvalData.reason, inline: false },
                        { name: 'Status', value: `✅ ${type.charAt(0).toUpperCase() + type.slice(1)} executed successfully`, inline: false }
                    )
                    .setTimestamp()
                    .setFooter({ text: `${type.charAt(0).toUpperCase() + type.slice(1)} completed` });

                await interaction.editReply({
                    embeds: [embed],
                    components: []
                });
            } else {
                // Get display name for failure message
                const guild = client.guilds.cache.get(approvalData.guildId);
                let displayName = approvalData.targetUsername;
                
                if (guild) {
                    try {
                        const targetMember = await guild.members.fetch(approvalData.targetId);
                        if (targetMember && targetMember.nickname) {
                            displayName = `${targetMember.nickname} (${approvalData.targetUsername})`;
                        }
                    } catch (error) {
                        // Member may have left, use stored username
                        console.log(`Could not fetch member ${approvalData.targetId} for failure message`);
                    }
                }

                const embed = new Discord.EmbedBuilder()
                    .setTitle(`${type.toUpperCase()} APPROVAL FAILED ❌`)
                    .setColor('#FF6600')
                    .addFields(
                        { name: 'Target User', value: `${displayName} (${approvalData.targetTag})`, inline: true },
                        { name: 'Requested By', value: approvalData.requesterTag, inline: true },
                        { name: 'Attempted By', value: `${interaction.user.username}#${interaction.user.discriminator}`, inline: true },
                        { name: 'Reason', value: approvalData.reason, inline: false },
                        { name: 'Status', value: `❌ Failed to execute ${type}. User may have left the server or insufficient permissions.`, inline: false }
                    )
                    .setTimestamp()
                    .setFooter({ text: 'Execution failed' });

                await interaction.editReply({
                    embeds: [embed],
                    components: []
                });
            }
        } else {
            // Decline the request
            pendingApprovals.delete(approvalId);

            // Get display name for decline message
            const guild = client.guilds.cache.get(approvalData.guildId);
            let displayName = approvalData.targetUsername;
            
            if (guild) {
                try {
                    const targetMember = await guild.members.fetch(approvalData.targetId);
                    if (targetMember && targetMember.nickname) {
                        displayName = `${targetMember.nickname} (${approvalData.targetUsername})`;
                    }
                } catch (error) {
                    // Member may have left, use stored username
                    console.log(`Could not fetch member ${approvalData.targetId} for decline message`);
                }
            }

            const embed = new Discord.EmbedBuilder()
                .setTitle(`${type.toUpperCase()} REQUEST DECLINED ❌`)
                .setColor('#FF0000')
                .addFields(
                    { name: 'Target User', value: `${displayName} (${approvalData.targetTag})`, inline: true },
                    { name: 'Requested By', value: approvalData.requesterTag, inline: true },
                    { name: 'Declined By', value: `${interaction.user.username}#${interaction.user.discriminator}`, inline: true },
                    { name: 'Reason', value: approvalData.reason, inline: false },
                    { name: 'Status', value: `❌ Request declined by moderator`, inline: false }
                )
                .setTimestamp()
                .setFooter({ text: 'Request declined' });

            await interaction.editReply({
                embeds: [embed],
                components: []
            });
        }

    } catch (error) {
        console.error('Error handling approval interaction:', error);

        try {
            // Only try to respond if interaction hasn't expired and we can still edit it
            if (interaction.deferred && !interaction.replied) {
                await interaction.editReply({
                    content: 'An error occurred while processing your request. Please try again.',
                    components: []
                });
            } else if (!interaction.replied && !interaction.deferred) {
                // Try to reply normally if not yet acknowledged
                await interaction.reply({
                    content: 'An error occurred while processing your request. Please try again.',
                    flags: Discord.MessageFlags.Ephemeral
                });
            }
        } catch (replyError) {
            console.error('Error sending error reply:', replyError.message);
            // Don't log full error details for known interaction expiry issues
        }
    }
}

async function executeModeration(approvalData, approver) {
    try {
        const { guildId, type, targetId, reason, deleteMessages } = approvalData;

        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            console.error(`Guild ${guildId} not found for moderation action`);
            return false;
        }

        if (type === 'kick') {
            const member = await guild.members.fetch(targetId).catch(() => null);
            if (!member) {
                console.log(`Member ${targetId} not found in guild, may have already left`);
                return false;
            }

            await member.kick(reason);
            console.log(`Successfully kicked ${approvalData.targetTag} from ${guild.name}`);

            // Log the action
            const { logAction } = require('./auditLogger');
            await logAction(guildId, 'MEMBER_KICK', {
                id: approver.id,
                tag: `${approver.username}#${approver.discriminator}`
            }, { id: targetId, tag: approvalData.targetTag }, `${reason} (Approved kick)`, {});

        } else if (type === 'ban') {
            let user;
            try {
                const member = await guild.members.fetch(targetId);
                user = member.user;
            } catch {
                user = await client.users.fetch(targetId).catch(() => null);
            }

            if (!user) {
                console.log(`User ${targetId} not found for ban`);
                return false;
            }

            await guild.members.ban(user, {
                reason: reason,
                deleteMessageDays: deleteMessages ? 7 : 0
            });
            console.log(`Successfully banned ${approvalData.targetTag} from ${guild.name}`);

            // Log the action
            const { logAction } = require('./auditLogger');
            await logAction(guildId, 'MEMBER_BAN', {
                id: approver.id,
                tag: `${approver.username}#${approver.discriminator}`
            }, { id: targetId, tag: approvalData.targetTag }, `${reason} (Approved ban)`, {
                extra: { deleteMessages: deleteMessages }
            });
        }

        return true;
    } catch (error) {
        console.error(`Error executing ${approvalData.type}:`, error);
        return false;
    }
}

module.exports = {
    sendApprovalRequest,
    handleApprovalInteraction,
    executeModeration
};
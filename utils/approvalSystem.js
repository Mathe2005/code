
const Discord = require('discord.js');
const client = require('../config/discord');

// Store pending approval requests
const pendingApprovals = new Map();

// Roles that can approve/decline requests
const APPROVAL_ROLES = ['1218176257146228827', '1347515485968793672'];

async function sendApprovalRequest(channel, requestData) {
    const { type, guildId, targetId, targetUsername, targetTag, requesterId, requesterTag, reason, deleteMessages } = requestData;

    try {
        const embed = new Discord.EmbedBuilder()
            .setTitle(`${type.toUpperCase()} REQUEST`)
            .setColor(type === 'ban' ? '#FF0000' : '#FFA500')
            .addFields(
                { name: 'Target User', value: `${targetUsername} (${targetTag})\nID: ${targetId}`, inline: true },
                { name: 'Requested By', value: `${requesterTag}\nID: ${requesterId}`, inline: true },
                { name: 'Reason', value: reason || 'No reason provided', inline: false }
            )
            .setTimestamp()
            .setFooter({ text: `Guild ID: ${guildId} | Auto-expires in 24 hours` });

        if (type === 'ban' && deleteMessages) {
            embed.addFields({ name: 'Delete Messages', value: 'Yes (7 days)', inline: true });
        }

        const approveButton = new Discord.ButtonBuilder()
            .setCustomId(`approve_${type}_${targetId}_${guildId}_${Date.now()}`)
            .setLabel(`Approve ${type.toUpperCase()}`)
            .setStyle(Discord.ButtonStyle.Success)
            .setEmoji('✅');

        const declineButton = new Discord.ButtonBuilder()
            .setCustomId(`decline_${type}_${targetId}_${guildId}_${Date.now()}`)
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
        const approvalId = `${type}_${targetId}_${guildId}_${Date.now()}`;
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

        // Auto-delete after 24 hours
        setTimeout(async () => {
            try {
                if (pendingApprovals.has(approvalId)) {
                    await message.delete();
                    pendingApprovals.delete(approvalId);
                    console.log(`Auto-deleted expired ${type} request for ${targetTag}`);
                }
            } catch (error) {
                console.error('Error auto-deleting approval request:', error);
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

        const [action, type, targetId, guildId, timestamp] = interaction.customId.split('_');
        if (!['approve', 'decline'].includes(action) || !['kick', 'ban'].includes(type)) return;

        // Check if user has permission to approve/decline
        const member = interaction.member;
        if (!member) {
            return interaction.reply({
                content: 'Error: Could not verify your permissions.',
                ephemeral: true
            });
        }

        const hasPermission = APPROVAL_ROLES.some(roleId => member.roles.cache.has(roleId));
        if (!hasPermission) {
            return interaction.reply({
                content: 'You do not have permission to approve/decline moderation requests.',
                ephemeral: true
            });
        }

        const approvalId = `${type}_${targetId}_${guildId}_${timestamp}`;
        const approvalData = pendingApprovals.get(approvalId);

        if (!approvalData) {
            return interaction.reply({
                content: 'This approval request has already been processed or expired.',
                ephemeral: true
            });
        }

        // Remove from pending approvals immediately to prevent duplicate processing
        pendingApprovals.delete(approvalId);

        if (action === 'approve') {
            // Execute the kick/ban
            const success = await executeModeration(approvalData, interaction.user);
            
            if (success) {
                const embed = new Discord.EmbedBuilder()
                    .setTitle(`${type.toUpperCase()} APPROVED & EXECUTED`)
                    .setColor('#00FF00')
                    .addFields(
                        { name: 'Target User', value: `${approvalData.targetUsername} (${approvalData.targetTag})`, inline: true },
                        { name: 'Requested By', value: approvalData.requesterTag, inline: true },
                        { name: 'Approved By', value: `${interaction.user.username}#${interaction.user.discriminator}`, inline: true },
                        { name: 'Reason', value: approvalData.reason, inline: false }
                    )
                    .setTimestamp();

                await interaction.update({
                    embeds: [embed],
                    components: []
                });
            } else {
                // Re-add to pending approvals if execution failed
                pendingApprovals.set(approvalId, approvalData);
                await interaction.reply({
                    content: `Failed to execute ${type}. The user may have left the server or an error occurred.`,
                    ephemeral: true
                });
            }
        } else {
            // Decline the request
            const embed = new Discord.EmbedBuilder()
                .setTitle(`${type.toUpperCase()} REQUEST DECLINED`)
                .setColor('#FF0000')
                .addFields(
                    { name: 'Target User', value: `${approvalData.targetUsername} (${approvalData.targetTag})`, inline: true },
                    { name: 'Requested By', value: approvalData.requesterTag, inline: true },
                    { name: 'Declined By', value: `${interaction.user.username}#${interaction.user.discriminator}`, inline: true },
                    { name: 'Reason', value: approvalData.reason, inline: false }
                )
                .setTimestamp();

            await interaction.update({
                embeds: [embed],
                components: []
            });
        }

    } catch (error) {
        console.error('Error handling approval interaction:', error);
        
        // Re-add to pending approvals if there was an error
        if (approvalData) {
            pendingApprovals.set(approvalId, approvalData);
        }
        
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: 'An error occurred while processing your request.',
                    ephemeral: true
                });
            }
        } catch (replyError) {
            console.error('Error sending error reply:', replyError);
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

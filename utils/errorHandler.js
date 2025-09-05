
// Centralized error handling utility
const Discord = require('discord.js');

class ErrorHandler {
    static async handleAsyncError(asyncFunction, context = 'Unknown') {
        try {
            return await asyncFunction();
        } catch (error) {
            console.error(`Error in ${context}:`, error);
            return null;
        }
    }

    static async safeInteractionReply(interaction, options, fallbackMessage = '❌ An error occurred.') {
        try {
            if (interaction.replied || interaction.deferred) {
                return await interaction.followUp(options);
            } else {
                return await interaction.reply(options);
            }
        } catch (error) {
            console.error('Error sending interaction reply:', error);
            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ 
                        content: fallbackMessage, 
                        flags: Discord.MessageFlags.Ephemeral 
                    });
                }
            } catch (fallbackError) {
                console.error('Error sending fallback reply:', fallbackError);
            }
        }
    }

    static async safeDatabaseOperation(operation, context = 'Database operation') {
        try {
            return await operation();
        } catch (error) {
            console.error(`Database error in ${context}:`, error);
            return null;
        }
    }

    static async safeDiscordOperation(operation, context = 'Discord operation') {
        try {
            return await operation();
        } catch (error) {
            if (error.code === 50013) {
                console.error(`Missing permissions for ${context}:`, error.message);
            } else if (error.code === 50001) {
                console.error(`Missing access for ${context}:`, error.message);
            } else if (error.code === 10008) {
                console.error(`Message not found for ${context}:`, error.message);
            } else if (error.code === 10062) {
                console.error(`Unknown interaction for ${context}:`, error.message);
            } else {
                console.error(`Discord API error in ${context}:`, error);
            }
            return null;
        }
    }

    static logError(error, context = 'Unknown') {
        console.error(`[${new Date().toISOString()}] Error in ${context}:`);
        console.error('Message:', error.message);
        console.error('Stack:', error.stack);
        
        if (error.code) {
            console.error('Error Code:', error.code);
        }
        
        if (error.statusCode) {
            console.error('Status Code:', error.statusCode);
        }
    }
}

module.exports = ErrorHandler;

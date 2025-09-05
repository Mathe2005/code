
const Discord = require('discord.js');
require('dotenv').config();

// Bot setup
const client = new Discord.Client({
    intents: [
        Discord.GatewayIntentBits.Guilds,
        Discord.GatewayIntentBits.GuildMessages,
        Discord.GatewayIntentBits.GuildMembers,
        Discord.GatewayIntentBits.MessageContent,
        Discord.GatewayIntentBits.GuildModeration,
        Discord.GatewayIntentBits.GuildVoiceStates
    ],
    // Enable raw events for Lavalink voice state handling
    ws: {
        intents: [
            Discord.GatewayIntentBits.Guilds,
            Discord.GatewayIntentBits.GuildMessages,
            Discord.GatewayIntentBits.GuildMembers,
            Discord.GatewayIntentBits.MessageContent,
            Discord.GatewayIntentBits.GuildModeration,
            Discord.GatewayIntentBits.GuildVoiceStates
        ]
    }
});

module.exports = client;

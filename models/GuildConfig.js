
const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    const GuildConfig = sequelize.define('GuildConfig', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true
        },
        guildId: {
            type: DataTypes.STRING(255),
            allowNull: false
        },
        prefix: {
            type: DataTypes.STRING(50),
            defaultValue: '!',
            allowNull: false
        },
        logChannel: {
            type: DataTypes.STRING(255),
            allowNull: true
        },
        specialSuffix: {
            type: DataTypes.STRING(255),
            defaultValue: '𝓗𝓮𝓷𝓷𝓮𝓼𝓼𝔂',
            allowNull: false
        },
        roleConfigs: {
            type: DataTypes.JSON,
            defaultValue: '[]',
            allowNull: false
        }
    }, {
        tableName: 'guild_configs',
        timestamps: true,
        indexes: [
            {
                unique: true,
                fields: ['guildId']
            }
        ]
    });

    return GuildConfig;
};

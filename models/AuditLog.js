const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    const AuditLog = sequelize.define('AuditLog', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true
        },
        guildId: {
            type: DataTypes.STRING,
            allowNull: false
        },
        action: {
            type: DataTypes.STRING,
            allowNull: false
        },
        category: {
            type: DataTypes.ENUM('MODERATION', 'MEMBER', 'MESSAGE', 'CHANNEL', 'ROLE', 'SERVER', 'CONFIG', 'MUSIC', 'VOICE', 'SYSTEM'),
            allowNull: false,
            defaultValue: 'MODERATION'
        },
        moderator: {
            type: DataTypes.STRING,
            allowNull: true
        },
        moderatorTag: {
            type: DataTypes.STRING,
            allowNull: true
        },
        target: {
            type: DataTypes.STRING,
            allowNull: true
        },
        targetTag: {
            type: DataTypes.STRING,
            allowNull: true
        },
        reason: {
            type: DataTypes.TEXT,
            allowNull: true
        },
        channelId: {
            type: DataTypes.STRING,
            allowNull: true
        },
        channelName: {
            type: DataTypes.STRING,
            allowNull: true
        },
        additionalData: {
            type: DataTypes.JSON,
            allowNull: true
        },
        timestamp: {
            type: DataTypes.DATE,
            allowNull: false,
            defaultValue: DataTypes.NOW
        }
    }, {
        tableName: 'audit_logs',
        timestamps: true,
        indexes: [
            { fields: ['guildId', 'timestamp'] },
            { fields: ['guildId', 'category'] },
            { fields: ['timestamp'] }
        ]
    });

    return AuditLog;
};

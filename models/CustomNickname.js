
const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    const CustomNickname = sequelize.define('CustomNickname', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true
        },
        userId: {
            type: DataTypes.STRING(255),
            allowNull: false
        },
        guildId: {
            type: DataTypes.STRING(255),
            allowNull: false
        },
        customNickname: {
            type: DataTypes.STRING(255),
            allowNull: false
        }
    }, {
        tableName: 'custom_nicknames',
        timestamps: true,
        indexes: [
            {
                unique: true,
                fields: ['userId', 'guildId']
            }
        ]
    });

    return CustomNickname;
};

// models/monitor.js
module.exports = (sequelize, DataTypes) => {
  const Monitor = sequelize.define('Monitor', {
    ipOrUrl: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true, // Ensure that the IP/URL is unique
    },
    lastStatus: {
      type: DataTypes.STRING,
      defaultValue: 'offline',
    },
    lastChecked: {
      type: DataTypes.DATE,
    },
    webhookUrl: {
      type: DataTypes.STRING,
      allowNull: true,
    },
  });

  return Monitor;
};

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define('MonitorLog', {
    ipOrUrl: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    timestamp: {
      type: DataTypes.DATE,
      defaultValue: sequelize.NOW,
    },
  });
};

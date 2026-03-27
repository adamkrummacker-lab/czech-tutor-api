// Sequelize inicializace a modely pro Tutor projekt
const { Sequelize, DataTypes } = require('sequelize');
const path = require('path');

const databaseUrl = process.env.DATABASE_URL;

const sequelize = databaseUrl ? new Sequelize(databaseUrl, {
  dialect: 'postgres',
  protocol: 'postgres',
  logging: false,
  dialectOptions: {
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  },
}) : new Sequelize({
  dialect: 'sqlite',
  storage: path.join(__dirname, 'tutor.sqlite'),
  logging: false,
});

// Model pro třídu
const Class = sequelize.define('Class', {
  name: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
});

// Model pro žáka
const Student = sequelize.define('Student', {
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
});

// Vztah: třída má více žáků
Class.hasMany(Student, { as: 'students' });
Student.belongsTo(Class);

module.exports = {
  sequelize,
  Class,
  Student,
};

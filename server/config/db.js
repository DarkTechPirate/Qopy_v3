const mongoose = require('mongoose');
const Admin = require('../models/Admin');
const bcrypt = require('bcryptjs');

const connectDB = async () => {
    try {
        const conn = await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/qopy_db');
        console.log(`MongoDB Connected: ${conn.connection.host}`);

        await seedAdmin();
    } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
    }
};

const seedAdmin = async () => {
    try {
        const adminCount = await Admin.countDocuments();
        if (adminCount === 0) {
            console.log('No admin found. Seeding default admin...');
            const salt = await bcrypt.genSalt(10);
            const hashedPassword = await bcrypt.hash('admin123', salt);

            await Admin.create({
                username: 'admin',
                password: hashedPassword
            });
            console.log('Default Admin seeded (username: admin, password: admin123)');
        }
    } catch (err) {
        console.error('Failed to seed admin:', err.message);
    }
};

module.exports = connectDB;

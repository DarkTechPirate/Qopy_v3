const mongoose = require('mongoose');
const Admin = require('../models/Admin');
const bcrypt = require('bcryptjs');

const connectDB = async () => {
    try {
        const uri = process.env.MONGO_URI;

        if (!uri) {
            throw new Error("MONGO_URI not found in environment");
        }

        const conn = await mongoose.connect(uri);
        console.log(`MongoDB Connected: ${conn.connection.host}`);

        await seedAdmin();
    } catch (error) {
        console.error(`MongoDB connection failed: ${error.message}`);
        console.error(`Attempted URI: ${process.env.MONGO_URI}`);
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

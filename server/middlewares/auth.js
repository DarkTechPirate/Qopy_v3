const Device = require('../models/Device');

// Middleware to authenticate device requests
async function authenticateDevice(req, res, next) {
    const deviceId = req.headers['device-id'];
    const authKey = req.headers['authorization'];
    if (!deviceId || !authKey) return res.status(401).json({ error: 'Missing device credentials' });

    try {
        const device = await Device.findOne({ deviceId, apiKey: authKey });
        if (!device) return res.status(403).json({ error: 'Invalid device credentials' });

        req.device = device;
        next();
    } catch (err) {
        return res.status(500).json({ error: 'Server error during device authentication' });
    }
}

module.exports = authenticateDevice;

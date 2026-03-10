const Device = require('../models/Device');

async function authenticateDevice(req, res, next) {
  const deviceId = req.headers['device-id'];
  const authKey = req.headers['authorization'];

  if (!deviceId || !authKey) {
    return res.status(401).json({ error: 'Missing device credentials' });
  }

  try {
    const device = await Device.findOne({ deviceId, apiKey: authKey });
    if (!device) {
      return res.status(403).json({ error: 'Invalid device credentials' });
    }
    req.device = device;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Auth check failed' });
  }
}

module.exports = authenticateDevice;

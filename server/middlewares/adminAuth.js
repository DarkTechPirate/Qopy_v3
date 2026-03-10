const jwt = require('jsonwebtoken');

const adminAuth = (req, res, next) => {
    const token = req.header('Authorization');

    if (!token) {
        return res.status(401).json({ error: 'No token, authorization denied' });
    }

    try {
        const bearer = token.split(' ')[1]; // "Bearer TOKEN"
        const decoded = jwt.verify(bearer, process.env.JWT_SECRET || 'qopy_super_secret_key');
        req.admin = decoded;
        next();
    } catch (err) {
        res.status(401).json({ error: 'Token is not valid' });
    }
};

module.exports = adminAuth;

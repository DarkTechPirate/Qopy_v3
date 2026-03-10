const path = require('path');

const PORT = process.env.PORT || 5000;
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

const PRICING = { bw: 3, color: 6 }; // per printed side in INR

module.exports = {
  PORT,
  UPLOAD_DIR,
  PRICING
};

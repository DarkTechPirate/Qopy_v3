const { execSync } = require('child_process');
const path = require('path');

const REQUIRED_DEPS = ['express', 'cors', 'multer', 'qrcode', 'pdf-lib', 'body-parser'];

function ensureDependencies() {
    let missing = [];
    for (const dep of REQUIRED_DEPS) {
        try { require.resolve(dep); }
        catch (_) { missing.push(dep); }
    }
    if (missing.length > 0) {
        console.log(`Installing missing dependencies: ${missing.join(', ')}...`);
        const serverDir = path.join(__dirname, '..');
        execSync(`npm install ${missing.join(' ')}`, { stdio: 'inherit', cwd: serverDir });
        console.log('Dependencies installed. Please restart the server.');
        process.exit(0);
    }
}

module.exports = { ensureDependencies };

const express = require('express');
const router = express.Router();

const adminController = require('../controllers/adminController');
const adminAuth = require('../middlewares/adminAuth');

// Public route to render HTML & perform login
router.get('/admin', adminController.getAdminHtml);
router.post('/admin/login', adminController.login);

// Protected data routes
router.get('/admin/jobs', adminAuth, adminController.getAdminJobs);
router.get('/admin/devices', adminAuth, adminController.getAdminDevices);
router.get('/admin/stats', adminAuth, adminController.getAdminStats);

module.exports = router;

const WebSocket = require('ws');
const Job = require('../models/Job');
const Device = require('../models/Device');
const { notifyJobUpdate } = require('./clientHandler');
const fs = require('fs');

// Map<deviceId, WebSocket>
const connectedDevices = new Map();

const PING_INTERVAL = 30000;
const AUTH_TIMEOUT = 5000;

function setupDeviceWS(wss) {
    // Ping/pong keep-alive
    const interval = setInterval(() => {
        wss.clients.forEach((ws) => {
            if (ws.isAlive === false) return ws.terminate();
            ws.isAlive = false;
            ws.ping();
        });
    }, PING_INTERVAL);

    wss.on('close', () => clearInterval(interval));

    wss.on('connection', (ws) => {
        ws.isAlive = true;
        ws.isAuthenticated = false;
        ws.deviceId = null;

        ws.on('pong', () => { ws.isAlive = true; });

        // Auth timeout: must register within 5 seconds
        const authTimer = setTimeout(() => {
            if (!ws.isAuthenticated) {
                ws.send(JSON.stringify({ type: 'AUTH_FAILED', reason: 'Registration timeout' }));
                ws.close();
            }
        }, AUTH_TIMEOUT);

        ws.on('message', async (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

            // Handle REGISTER before authentication
            if (msg.type === 'REGISTER') {
                try {
                    const device = await Device.findOne({ deviceId: msg.deviceId });
                    if (!device || device.apiKey !== msg.apiKey) {
                        ws.send(JSON.stringify({ type: 'AUTH_FAILED', reason: 'Invalid credentials' }));
                        ws.close();
                        return;
                    }

                    // Close any existing connection for this device
                    const existing = connectedDevices.get(msg.deviceId);
                    if (existing && existing !== ws && existing.readyState === WebSocket.OPEN) {
                        existing.close();
                    }

                    ws.isAuthenticated = true;
                    ws.deviceId = msg.deviceId;
                    clearTimeout(authTimer);
                    connectedDevices.set(msg.deviceId, ws);

                    // Update device status in DB
                    device.isOnline = true;
                    device.lastSeen = new Date();
                    // Optionally store fingerprint if the new python client sent it
                    if (msg.fingerprint) {
                        device.fingerprint = msg.fingerprint;
                    }
                    await device.save();

                    ws.send(JSON.stringify({
                        // The new python client expects REGISTERED, Node.js can use it too
                        type: 'REGISTERED',
                        deviceId: msg.deviceId,
                        serverTime: new Date().toISOString(),
                    }));

                    console.log(`  Device ${msg.deviceId} connected via WebSocket`);

                    // Send all pending PAID jobs for this device
                    const pendingJobs = await Job.find({
                        deviceId: msg.deviceId,
                        status: 'PAID',
                    }).sort({ createdAt: 1 });

                    for (const job of pendingJobs) {
                        ws.send(JSON.stringify({
                            type: 'NEW_JOB',
                            job: {
                                jobId: job.jobId, fileName: job.fileName, pages: job.pages,
                                sheets: job.sheets, printType: job.printType, sided: job.sided,
                                copies: job.copies,
                                // Passing downloadUrl explicitly simplifies kiosk client downloads
                                downloadUrl: `/api/device/download/${job.jobId}`
                            }
                        }));
                    }

                    if (pendingJobs.length > 0) {
                        console.log(`  Sent ${pendingJobs.length} pending job(s) to ${msg.deviceId}`);
                    }
                } catch (err) {
                    console.error('  Device register error:', err.message);
                    ws.send(JSON.stringify({ type: 'AUTH_FAILED', reason: 'Server error' }));
                    ws.close();
                }
                return;
            }

            // All other messages require authentication
            if (!ws.isAuthenticated) {
                ws.send(JSON.stringify({ type: 'ERROR', message: 'Not authenticated' }));
                return;
            }

            try {
                await handleDeviceMessage(ws, msg);
            } catch (err) {
                console.error(`  Device ${ws.deviceId} message error:`, err.message);
                ws.send(JSON.stringify({ type: 'ERROR', message: err.message }));
            }
        });

        ws.on('close', async () => {
            clearTimeout(authTimer);
            if (ws.deviceId) {
                connectedDevices.delete(ws.deviceId);
                try {
                    await Device.updateOne(
                        { deviceId: ws.deviceId },
                        { isOnline: false, lastSeen: new Date() }
                    );
                } catch (_) { }
                console.log(`  Device ${ws.deviceId} disconnected`);
            }
        });

        ws.on('error', (err) => {
            console.error(`  Device WS error:`, err.message);
        });
    });
}

async function handleDeviceMessage(ws, msg) {
    switch (msg.type) {

        case 'JOB_ACCEPTED': {
            const job = await Job.findOne({ jobId: msg.jobId, deviceId: ws.deviceId });
            if (!job) {
                ws.send(JSON.stringify({ type: 'ERROR', message: 'Job not found', jobId: msg.jobId }));
                return;
            }
            if (job.status !== 'PAID') {
                ws.send(JSON.stringify({ type: 'ERROR', message: `Cannot accept job in ${job.status} state`, jobId: msg.jobId }));
                return;
            }

            job.status = 'ASSIGNED';
            job.statusMessage = 'Printer accepted your job';
            await job.save();

            ws.send(JSON.stringify({ type: 'JOB_ACK', jobId: msg.jobId, status: 'ASSIGNED' }));
            notifyJobUpdate(msg.jobId, { status: 'ASSIGNED', message: job.statusMessage });
            break;
        }

        case 'JOB_REJECTED': {
            const job = await Job.findOne({ jobId: msg.jobId, deviceId: ws.deviceId });
            if (!job) return;
            job.statusMessage = 'Job rejected by printer queue: ' + (msg.reason || 'unknown');
            // keep it PAID, another kiosk or same could pick it up if it was a pool, but for now we just log it
            await job.save();
            notifyJobUpdate(msg.jobId, { status: job.status, message: job.statusMessage });
            break;
        }

        case 'REQUEST_JOB_DETAILS': {
            const job = await Job.findOne({ jobId: msg.jobId, deviceId: ws.deviceId });
            if (!job) {
                ws.send(JSON.stringify({ type: 'ERROR', message: 'Job not found', jobId: msg.jobId }));
                return;
            }
            if (!['ASSIGNED', 'PAID'].includes(job.status)) {
                ws.send(JSON.stringify({ type: 'ERROR', message: `Job not available in ${job.status} state`, jobId: msg.jobId }));
                return;
            }

            ws.send(JSON.stringify({
                type: 'JOB_DETAILS',
                jobId: job.jobId,
                fileName: job.fileName,
                pages: job.pages,
                sheets: job.sheets,
                printType: job.printType,
                sided: job.sided,
                copies: job.copies,
                downloadUrl: `/api/device/download/${job.jobId}`,
            }));
            break;
        }

        case 'JOB_PRINTING': {
            const job = await Job.findOne({ jobId: msg.jobId, deviceId: ws.deviceId });
            if (!job) return;
            if (job.status !== 'ASSIGNED' && job.status !== 'PAID') return;

            job.status = 'PRINTING';
            job.statusMessage = 'Your document is being printed...';
            await job.save();

            notifyJobUpdate(msg.jobId, { status: 'PRINTING', message: job.statusMessage });
            break;
        }

        case 'JOB_PROGRESS': {
            const job = await Job.findOne({ jobId: msg.jobId, deviceId: ws.deviceId });
            if (!job) return;
            if (job.status !== 'PRINTING') return;

            job.printedPages = msg.printedPages || 0;
            job.printProgress = msg.message || `Printing page ${msg.printedPages} of ${msg.totalPages || (job.pages * (job.copies || 1))}`;
            await job.save();

            notifyJobUpdate(msg.jobId, {
                status: 'PRINTING',
                printedPages: msg.printedPages,
                totalPages: msg.totalPages,
                message: job.printProgress,
            });
            break;
        }

        case 'JOB_COMPLETED': {
            const job = await Job.findOne({ jobId: msg.jobId, deviceId: ws.deviceId });
            if (!job) return;
            if (job.status !== 'PRINTING') return;

            job.status = 'COMPLETED';
            job.completedAt = new Date();
            job.statusMessage = msg.message || 'Printed successfully';
            job.printedPages = job.pages * (job.copies || 1);
            await job.save();

            // Delete uploaded file from disk
            if (job.filePath) {
                fs.unlink(job.filePath, (err) => {
                    if (err) console.error('  File cleanup failed:', err.message);
                    else console.log(`  Cleaned up file for job ${msg.jobId}`);
                });
                job.filePath = null; // Important to reflect removal
                await job.save();
            }

            notifyJobUpdate(msg.jobId, {
                status: 'COMPLETED',
                message: 'Your document has been printed! Collect from the kiosk.',
            });

            console.log(`  Job ${msg.jobId.slice(0, 8)} completed on ${ws.deviceId}`);
            break;
        }

        case 'JOB_FAILED': {
            const job = await Job.findOne({ jobId: msg.jobId, deviceId: ws.deviceId });
            if (!job) return;
            if (!['PRINTING', 'ASSIGNED', 'PAID'].includes(job.status)) return;

            job.status = 'FAILED';
            job.statusMessage = msg.message || 'Print failed';
            await job.save();

            notifyJobUpdate(msg.jobId, {
                status: 'FAILED',
                message: msg.message || 'Printing failed. Please contact support.',
            });

            console.log(`  Job ${msg.jobId.slice(0, 8)} failed on ${ws.deviceId}: ${msg.message}`);
            break;
        }

        case 'HEARTBEAT': {
            try {
                await Device.updateOne(
                    { deviceId: ws.deviceId },
                    {
                        lastSeen: new Date(),
                        printerStatus: msg.printerStatus || 'unknown',
                        paperLevel: msg.paperLevel || 'unknown',
                        inkLevel: msg.inkLevel || 'unknown',
                    }
                );
            } catch (_) { }

            ws.send(JSON.stringify({ type: 'HEARTBEAT_ACK', serverTime: new Date().toISOString() }));
            break;
        }

        case 'DEVICE_STATUS': {
            try {
                // From python client crash-recovery ping
                await Device.updateOne(
                    { deviceId: ws.deviceId },
                    {
                        lastSeen: new Date(),
                        printerStatus: msg.printerStatus || 'unknown',
                    }
                );

                if (msg.pendingJobId) {
                    // Server verifies if the pending job is still valid for this device
                    const job = await Job.findOne({ jobId: msg.pendingJobId, deviceId: ws.deviceId });
                    if (job && ['PAID', 'ASSIGNED', 'PRINTING'].includes(job.status)) {
                        ws.send(JSON.stringify({
                            type: 'PENDING_JOB',
                            job: {
                                jobId: job.jobId, fileName: job.fileName, pages: job.pages,
                                sheets: job.sheets, printType: job.printType, sided: job.sided,
                                copies: job.copies, downloadUrl: `/api/device/download/${job.jobId}`
                            }
                        }));
                    }
                }
            } catch (_) { }
            break;
        }

        default:
            ws.send(JSON.stringify({ type: 'ERROR', message: `Unknown message type: ${msg.type}` }));
    }
}

function sendJobToDevice(deviceId, message) {
    const ws = connectedDevices.get(deviceId);
    // Send right away if connected
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
        return true;
    }
    return false;
}

function getConnectedDevices() {
    return connectedDevices;
}

module.exports = { setupDeviceWS, sendJobToDevice, getConnectedDevices };

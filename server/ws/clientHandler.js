const WebSocket = require('ws');

// Map<jobId, Set<WebSocket>> -- multiple browsers can watch the same job
const jobSubscribers = new Map();

function setupClientWS(wss) {
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.subscribedJobIds = new Set();

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

      switch (msg.type) {
        case 'SUBSCRIBE': {
          const { jobId } = msg;
          if (!jobId) return;

          if (!jobSubscribers.has(jobId)) {
            jobSubscribers.set(jobId, new Set());
          }
          jobSubscribers.get(jobId).add(ws);
          ws.subscribedJobIds.add(jobId);

          ws.send(JSON.stringify({ type: 'SUBSCRIBED', jobId }));

          // Send current status immediately
          const PrintJob = require('../models/PrintJob');
          PrintJob.findOne({ jobId }).then(job => {
            if (job && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'JOB_STATUS',
                jobId: job.jobId,
                status: job.status,
                printedPages: job.printedPages || 0,
                totalPages: job.pages * (job.copies || 1),
                message: job.statusMessage || null,
                paymentId: job.paymentId,
                timestamp: new Date().toISOString(),
              }));
            }
          }).catch(() => {});
          break;
        }

        case 'UNSUBSCRIBE': {
          const { jobId } = msg;
          if (!jobId) return;
          const subs = jobSubscribers.get(jobId);
          if (subs) {
            subs.delete(ws);
            if (subs.size === 0) jobSubscribers.delete(jobId);
          }
          ws.subscribedJobIds.delete(jobId);
          break;
        }
      }
    });

    ws.on('close', () => {
      // Clean up all subscriptions for this socket
      for (const jobId of ws.subscribedJobIds) {
        const subs = jobSubscribers.get(jobId);
        if (subs) {
          subs.delete(ws);
          if (subs.size === 0) jobSubscribers.delete(jobId);
        }
      }
    });
  });

  // Ping/pong keep-alive for client connections
  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => clearInterval(interval));
}

function notifyJobUpdate(jobId, payload) {
  const subscribers = jobSubscribers.get(jobId);
  if (!subscribers || subscribers.size === 0) return;

  const message = JSON.stringify({
    type: 'JOB_STATUS',
    jobId,
    ...payload,
    timestamp: new Date().toISOString(),
  });

  for (const ws of subscribers) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

module.exports = { setupClientWS, notifyJobUpdate };

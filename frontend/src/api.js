const API_BASE = import.meta.env.VITE_API_URL || '';

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

export async function uploadPDF(file) {
  const formData = new FormData();
  formData.append('file', file);
  return request('/api/upload', { method: 'POST', body: formData });
}

export async function setJobOptions(jobId, printType, sided, copies) {
  return request('/api/job/options', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId, printType, sided, copies })
  });
}

export async function getPaymentQR(jobId) {
  return request(`/api/payment/qr/${jobId}`);
}

export async function confirmPayment(jobId) {
  return request('/api/payment/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId })
  });
}

export async function getJobStatus(jobId) {
  return request(`/api/job/status/${jobId}`);
}

// WebSocket helper for real-time job status updates
export function createJobStatusSocket(jobId, onUpdate, onError) {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsBase = import.meta.env.VITE_WS_URL || `${wsProtocol}//${window.location.host}`;
  const ws = new WebSocket(`${wsBase}/ws/client`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'SUBSCRIBE', jobId }));
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'JOB_STATUS') {
        onUpdate(msg);
      }
    } catch (err) {
      if (onError) onError(err);
    }
  };

  ws.onerror = () => {
    // Fallback: if WS fails, do a single REST poll
    if (onError) {
      getJobStatus(jobId)
        .then(data => onUpdate({ type: 'JOB_STATUS', jobId, status: data.status, message: null }))
        .catch(() => {});
    }
  };

  // Return cleanup function
  return () => {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  };
}

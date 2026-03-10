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

export async function setJobOptions(jobId, printType, sided, copies, orientation, pagesPerSheet) {
  return request('/api/job/options', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId, printType, sided, copies, orientation, pagesPerSheet })
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

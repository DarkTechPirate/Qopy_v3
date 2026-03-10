import { useState, useEffect, useRef } from 'react';
import { getJobStatus } from '../api';

const TRACKER_LABELS = ['Paid', 'Queued', 'Printing', 'Done'];

function trackerLevel(status) {
  if (status === 'COMPLETED') return 4;
  if (status === 'FAILED') return 4;
  if (status === 'PRINTING') return 3;
  return 1; // PAID
}

export default function Confirmation({ job, onReset }) {
  const [status, setStatus] = useState('PAID');
  const [message, setMessage] = useState('Your document will be printed shortly.');
  const intervalRef = useRef(null);

  useEffect(() => {
    intervalRef.current = setInterval(async () => {
      try {
        const data = await getJobStatus(job.jobId);
        setStatus(data.status);
        if (data.status === 'COMPLETED') {
          setMessage('Your document has been printed! Collect from the kiosk.');
          clearInterval(intervalRef.current);
        } else if (data.status === 'FAILED') {
          setMessage('Printing failed. Please contact support.');
          clearInterval(intervalRef.current);
        } else if (data.status === 'PRINTING') {
          setMessage('Your document is being printed...');
        }
      } catch (_) {
        // ignore polling errors
      }
    }, 3000);

    return () => clearInterval(intervalRef.current);
  }, [job.jobId]);

  const level = trackerLevel(status);

  return (
    <div>
      {/* Icon */}
      <div className="confirm-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
      </div>

      <div className="confirm-heading">Print Job Queued!</div>
      <div className="confirm-sub">{message}</div>

      {/* Job details */}
      <div className="summary-box">
        <div className="summary-row">
          <span>Job ID</span>
          <span style={{ fontFamily: 'monospace', fontSize: 12 }}>
            {job.jobId?.slice(0, 8).toUpperCase()}
          </span>
        </div>
        <div className="summary-row">
          <span>Payment ID</span>
          <span style={{ fontFamily: 'monospace', fontSize: 12 }}>
            {job.paymentId}
          </span>
        </div>
        <div className="summary-row">
          <span>Status</span>
          <span>
            <span className={`status-badge status-${status}`}>
              {status.replace(/_/g, ' ')}
            </span>
          </span>
        </div>
        <div className="summary-row">
          <span>Kiosk</span>
          <span>KIOSK_001</span>
        </div>
      </div>

      {/* Progress tracker */}
      <div className="tracker">
        <div className="tracker-title">Job Progress</div>
        <div className="tracker-steps">
          {TRACKER_LABELS.map((label, i) => (
            <div key={label} className={`tracker-step${i < level ? ' active' : ''}`}>
              <div className="tracker-dot" />
              {label}
            </div>
          ))}
        </div>
      </div>

      <button className="btn" onClick={onReset} style={{ marginTop: 24 }}>
        Print Another Document
      </button>
    </div>
  );
}

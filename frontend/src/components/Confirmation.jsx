import { useState, useEffect } from 'react';
import { createJobStatusSocket } from '../api';

const TRACKER_LABELS = ['Paid', 'Queued', 'Printing', 'Done'];

function trackerLevel(status) {
  if (status === 'COMPLETED') return 4;
  if (status === 'FAILED') return 4;
  if (status === 'PRINTING') return 3;
  if (status === 'ASSIGNED') return 2;
  return 1; // PAID
}

export default function Confirmation({ job, onReset }) {
  const [status, setStatus] = useState('PAID');
  const [message, setMessage] = useState('Your document will be printed shortly.');
  const [printedPages, setPrintedPages] = useState(0);
  const [totalPages, setTotalPages] = useState(job.pages || 0);

  useEffect(() => {
    const cleanup = createJobStatusSocket(
      job.jobId,
      (update) => {
        setStatus(update.status);
        if (update.printedPages != null) setPrintedPages(update.printedPages);
        if (update.totalPages != null) setTotalPages(update.totalPages);

        switch (update.status) {
          case 'PAID':
            setMessage(update.message || 'Payment confirmed. Waiting for printer...');
            break;
          case 'ASSIGNED':
            setMessage('Printer accepted your job. Preparing...');
            break;
          case 'PRINTING':
            setMessage(update.message || 'Your document is being printed...');
            break;
          case 'COMPLETED':
            setMessage('Your document has been printed! Collect from the kiosk.');
            break;
          case 'FAILED':
            setMessage('Printing failed. Please contact support.');
            break;
        }
      },
      (err) => {
        // WS error fallback handled inside createJobStatusSocket
      }
    );

    return cleanup;
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
        {status === 'PRINTING' && totalPages > 0 && (
          <div className="summary-row">
            <span>Progress</span>
            <span>{printedPages} / {totalPages} pages</span>
          </div>
        )}
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

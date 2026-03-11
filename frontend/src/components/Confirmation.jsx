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
  const [printedPages, setPrintedPages] = useState(0);
  const [totalPages, setTotalPages] = useState(job.pages * (job.copies || 1));
  const wsRef = useRef(null);

  useEffect(() => {
    // 1. Establish WebSocket Connection
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/client`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (job.jobId) {
        ws.send(JSON.stringify({ type: 'SUBSCRIBE', jobId: job.jobId }));
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'JOB_STATUS' && data.jobId === job.jobId) {
          setStatus(data.status);

          // Save to local storage once the job is confirmed
          if (['PAID', 'ASSIGNED', 'PRINTING', 'COMPLETED', 'FAILED'].includes(data.status)) {
            const historyStr = localStorage.getItem('qopy_print_history');
            let history = [];
            try {
              history = historyStr ? JSON.parse(historyStr) : [];
            } catch (e) {
              history = [];
            }
            if (!history.includes(job.jobId)) {
              history.unshift(job.jobId);
              localStorage.setItem('qopy_print_history', JSON.stringify(history));
            }
          }

          if (data.printedPages !== undefined) setPrintedPages(data.printedPages);
          if (data.totalPages !== undefined) setTotalPages(data.totalPages);

          if (data.status === 'COMPLETED') {
            setMessage('Your document has been printed! Collect from the kiosk.');
          } else if (data.status === 'FAILED') {
            setMessage('Printing failed. Please contact support.');
          } else if (data.status === 'PRINTING') {
            setMessage(data.message || 'Your document is being printed...');
          } else {
            setMessage(data.message || 'Your document will be printed shortly.');
          }
        }
      } catch (err) {
        console.error('Failed to parse WS message:', err);
      }
    };

    return () => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.close();
      }
    };
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

      <div className="summary-box">
        <div className="summary-row">
          <span>File Name</span>
          <span style={{ fontWeight: 600 }}>{job.fileName}</span>
        </div>
        <div className="summary-row">
          <span>Page Count</span>
          <span>{job.pages} pages (x{job.copies || 1} copies)</span>
        </div>
        <div className="summary-row">
          <span>Settings</span>
          <span>{job.printType === 'bw' ? 'B&W' : 'Color'}, {job.sided === 'double' ? 'Double' : 'Single'} Sided</span>
        </div>
        <div className="summary-row">
          <span>Job ID</span>
          <span style={{ fontFamily: 'monospace', fontSize: 12 }}>
            {job.jobId?.slice(0, 8).toUpperCase()}
          </span>
        </div>
        <div className="summary-row">
          <span>Kiosk</span>
          <span>KIOSK_001</span>
        </div>
      </div>

      {/* Real-time Progress Bar */}
      {status === 'PRINTING' && (
        <div style={{ margin: '20px 0', padding: '16px', border: '2px solid #000', borderRadius: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '14px', fontWeight: 'bold' }}>
            <span>Printing Progress</span>
            <span>{Math.round((printedPages / totalPages) * 100)}%</span>
          </div>
          <div style={{ width: '100%', height: '12px', background: '#eee', borderRadius: '6px', overflow: 'hidden' }}>
            <div style={{
              width: `${(printedPages / totalPages) * 100}%`,
              height: '100%',
              background: '#000',
              transition: 'width 0.4s ease-out'
            }} />
          </div>
          <div style={{ marginTop: '8px', fontSize: '12px', color: '#666', textAlign: 'center' }}>
            Printed {printedPages} of {totalPages} pages
          </div>
        </div>
      )}

      {/* Progress tracker steps */}
      <div className="tracker">
        <div className="tracker-title">Status Sequence</div>
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

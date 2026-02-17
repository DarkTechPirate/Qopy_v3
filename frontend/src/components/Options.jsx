import { useState } from 'react';
import { setJobOptions, getPaymentQR } from '../api';

const PRICING = { bw: 3, color: 6 };

export default function Options({ job, updateJob, onProceed, onBack, onError }) {
  const [loading, setLoading] = useState(false);

  const { pages, printType, sided, copies } = job;
  const sheets = sided === 'double' ? Math.ceil(pages / 2) : pages;
  const rate = PRICING[printType];
  const total = sheets * rate * copies;

  const handleProceed = async () => {
    onError(null);
    setLoading(true);
    try {
      const data = await setJobOptions(job.jobId, printType, sided, copies);
      const qrData = await getPaymentQR(job.jobId);
      onProceed({
        sheets: data.sheets,
        totalAmount: data.totalAmount,
        qrCode: qrData.qrCode,
      });
    } catch (err) {
      onError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h2 className="screen-title">Print Options</h2>

      {/* File info bar */}
      <div className="file-bar">
        <div className="file-bar-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
        </div>
        <div>
          <div className="file-bar-name">{job.fileName}</div>
          <div className="file-bar-pages">{pages} page{pages !== 1 ? 's' : ''}</div>
        </div>
      </div>

      {/* Print type */}
      <div className="option-group">
        <div className="option-label">Print Type</div>
        <div className="option-cards">
          <div
            className={`option-card${printType === 'bw' ? ' selected' : ''}`}
            onClick={() => updateJob({ printType: 'bw' })}
          >
            <div className="option-card-title">Black & White</div>
            <div className="option-card-sub">{'\u20B9'}3 per page</div>
          </div>
          <div
            className={`option-card${printType === 'color' ? ' selected' : ''}`}
            onClick={() => updateJob({ printType: 'color' })}
          >
            <div className="option-card-title">Color</div>
            <div className="option-card-sub">{'\u20B9'}6 per page</div>
          </div>
        </div>
      </div>

      {/* Sides */}
      <div className="option-group">
        <div className="option-label">Sides</div>
        <div className="option-cards">
          <div
            className={`option-card${sided === 'single' ? ' selected' : ''}`}
            onClick={() => updateJob({ sided: 'single' })}
          >
            <div className="option-card-title">Single Side</div>
            <div className="option-card-sub">One side per sheet</div>
          </div>
          <div
            className={`option-card${sided === 'double' ? ' selected' : ''}`}
            onClick={() => updateJob({ sided: 'double' })}
          >
            <div className="option-card-title">Double Side</div>
            <div className="option-card-sub">Both sides</div>
          </div>
        </div>
      </div>

      {/* Copies */}
      <div className="option-group">
        <div className="option-label">Copies</div>
        <div className="copies-row">
          <button
            className="copies-btn"
            onClick={() => updateJob({ copies: Math.max(1, copies - 1) })}
          >
            &minus;
          </button>
          <span className="copies-value">{copies}</span>
          <button
            className="copies-btn"
            onClick={() => updateJob({ copies: Math.min(99, copies + 1) })}
          >
            +
          </button>
        </div>
      </div>

      {/* Summary */}
      <div className="summary-box">
        <div className="summary-row">
          <span>Pages</span>
          <span>{pages}</span>
        </div>
        <div className="summary-row">
          <span>Sheets</span>
          <span>{sheets}</span>
        </div>
        <div className="summary-row">
          <span>Print Type</span>
          <span>{printType === 'bw' ? 'Black & White' : 'Color'}</span>
        </div>
        <div className="summary-row">
          <span>Sides</span>
          <span>{sided === 'single' ? 'Single Side' : 'Double Side'}</span>
        </div>
        <div className="summary-row">
          <span>Rate</span>
          <span>{'\u20B9'}{rate}{sided === 'double' ? '/sheet' : '/page'}</span>
        </div>
        <div className="summary-row">
          <span>Copies</span>
          <span>{copies}</span>
        </div>
        <div className="summary-row total">
          <span>Total</span>
          <span>{'\u20B9'}{total}</span>
        </div>
      </div>

      <button className="btn" onClick={handleProceed} disabled={loading}>
        {loading ? <><span className="loader" /> Processing...</> : 'Proceed to Payment'}
      </button>
      <button className="btn btn-outline" onClick={onBack}>Back</button>
    </div>
  );
}

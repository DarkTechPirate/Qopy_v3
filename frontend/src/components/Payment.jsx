import { useState } from 'react';
import { confirmPayment } from '../api';

export default function Payment({ job, onConfirmed, onBack, onError }) {
  const [confirming, setConfirming] = useState(false);

  const handleConfirm = async () => {
    onError(null);
    setConfirming(true);
    try {
      const data = await confirmPayment(job.jobId);
      onConfirmed(data);
    } catch (err) {
      onError(err.message);
    } finally {
      setConfirming(false);
    }
  };

  const optionsLabel =
    (job.printType === 'bw' ? 'B&W' : 'Color') +
    ', ' +
    (job.sided === 'single' ? 'Single' : 'Double') +
    ' sided' +
    (job.copies > 1 ? `, x${job.copies}` : '');

  return (
    <div>
      <h2 className="screen-title" style={{ textAlign: 'center' }}>
        Scan & Pay
      </h2>

      <div className="pay-amount">{'\u20B9'}{job.totalAmount}</div>

      <div className="qr-wrap">
        <img src={job.qrCode} alt="UPI QR Code" width={240} height={240} />
      </div>

      <div className="qr-note">Scan with any UPI app to pay</div>

      <div className="summary-box">
        <div className="summary-row">
          <span>File</span>
          <span>{job.fileName}</span>
        </div>
        <div className="summary-row">
          <span>Pages</span>
          <span>
            {job.pages} page{job.pages !== 1 ? 's' : ''}, {job.sheets} sheet
            {job.sheets !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="summary-row">
          <span>Options</span>
          <span>{optionsLabel}</span>
        </div>
        <div className="summary-row total">
          <span>Amount</span>
          <span>{'\u20B9'}{job.totalAmount}</span>
        </div>
      </div>

      <button className="btn" onClick={handleConfirm} disabled={confirming}>
        {confirming ? (
          <>
            <span className="loader" /> Verifying payment...
          </>
        ) : (
          'Confirm Payment (Simulated)'
        )}
      </button>
      <button className="btn btn-outline" onClick={onBack} disabled={confirming}>
        Back
      </button>
    </div>
  );
}

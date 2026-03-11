import { useState, useCallback } from 'react';
import Upload from './components/Upload';
import Options from './components/Options';
import Payment from './components/Payment';
import Confirmation from './components/Confirmation';
import History from './components/History';

const TOTAL_STEPS = 4;

export default function App() {
  const [step, setStep] = useState(1);
  const [error, setError] = useState(null);
  const [job, setJob] = useState({
    jobId: null,
    fileName: null,
    pages: 0,
    printType: 'bw',
    sided: 'single',
    orientation: 'portrait',
    pagesPerSheet: 1,
    copies: 1,
    sheets: 0,
    totalAmount: 0,
    paymentId: null,
    qrCode: null,
  });

  const updateJob = useCallback((updates) => {
    setJob((prev) => ({ ...prev, ...updates }));
  }, []);

  const goTo = useCallback((s) => {
    setError(null);
    setStep(s);
  }, []);

  const reset = useCallback(() => {
    setJob({
      jobId: null,
      fileName: null,
      pages: 0,
      printType: 'bw',
      sided: 'single',
      orientation: 'portrait',
      pagesPerSheet: 1,
      copies: 1,
      sheets: 0,
      totalAmount: 0,
      paymentId: null,
      qrCode: null,
    });
    setError(null);
    setStep(1);
  }, []);

  return (
    <>
      <header className="header">
        <div className="header-brand" onClick={reset} style={{ cursor: 'pointer' }}>
          <h1>QOPY</h1>
          <span className="tagline">Self-Service Printing</span>
        </div>
        <button
          className="btn btn-outline"
          onClick={() => goTo(0)}
          style={{ padding: '6px 12px', fontSize: '13px' }}
        >
          View History
        </button>
      </header>

      <div className="container">
        {/* Step dots */}
        <div className="steps">
          {Array.from({ length: TOTAL_STEPS }, (_, i) => {
            const n = i + 1;
            let cls = 'step-dot';
            if (n === step) cls += ' active';
            else if (n < step) cls += ' done';
            return <div key={n} className={cls} />;
          })}
        </div>

        {/* Error banner */}
        {error && <div className="error-banner">{error}</div>}

        {/* History Screen (step 0) */}
        {step === 0 && <History onBack={() => goTo(1)} />}

        {/* Screens */}
        {step === 1 && (
          <Upload
            onDone={(data) => {
              updateJob({ jobId: data.jobId, fileName: data.fileName, pages: data.pages });
              goTo(2);
            }}
            onError={setError}
          />
        )}
        {step === 2 && (
          <Options
            job={job}
            updateJob={updateJob}
            onProceed={(data) => {
              updateJob({
                sheets: data.sheets,
                totalAmount: data.totalAmount,
                qrCode: data.qrCode,
              });
              goTo(3);
            }}
            onBack={() => goTo(1)}
            onError={setError}
          />
        )}
        {step === 3 && (
          <Payment
            job={job}
            onConfirmed={(data) => {
              updateJob({ paymentId: data.paymentId });
              goTo(4);
            }}
            onBack={() => goTo(2)}
            onError={setError}
          />
        )}
        {step === 4 && <Confirmation job={job} onReset={reset} />}
      </div>
    </>
  );
}

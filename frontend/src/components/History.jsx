import { useState, useEffect } from 'react';
import { getJobStatus } from '../api';

export default function History({ onBack }) {
    const [jobs, setJobs] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        async function fetchHistory() {
            const historyStr = localStorage.getItem('qopy_print_history');
            if (!historyStr) {
                setLoading(false);
                return;
            }

            try {
                const jobIds = JSON.parse(historyStr);
                if (!Array.isArray(jobIds) || jobIds.length === 0) {
                    setLoading(false);
                    return;
                }

                // Fetch details for all jobs in parallel
                const jobPromises = jobIds.map(id => getJobStatus(id).catch(() => null));
                const results = await Promise.all(jobPromises);

                // Filter out nulls (failed requests or deleted jobs)
                const validJobs = results.filter(job => job !== null);
                setJobs(validJobs);
            } catch (err) {
                console.error('Failed to parse history from local storage:', err);
            } finally {
                setLoading(false);
            }
        }

        fetchHistory();
    }, []);

    const handleClearHistory = () => {
        if (window.confirm('Are you sure you want to clear your print history?')) {
            localStorage.removeItem('qopy_print_history');
            setJobs([]);
        }
    };

    const formatDate = (dateString) => {
        if (!dateString) return 'N/A';
        const d = new Date(dateString);
        return new Intl.DateTimeFormat('en-US', {
            month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
        }).format(d);
    };

    return (
        <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                <h2 className="screen-title" style={{ margin: 0 }}>Print History</h2>
                {jobs.length > 0 && (
                    <button
                        className="btn btn-outline"
                        onClick={handleClearHistory}
                        style={{ padding: '8px 12px', fontSize: '12px' }}
                    >
                        Clear History
                    </button>
                )}
            </div>

            {loading ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '40px' }}>
                    <span className="loader" />
                </div>
            ) : jobs.length === 0 ? (
                <div className="summary-box" style={{ textAlign: 'center', padding: '40px 20px' }}>
                    <svg viewBox="0 0 24 24" width="48" height="48" stroke="#ccc" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: '16px' }}>
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                        <polyline points="14 2 14 8 20 8"></polyline>
                        <line x1="16" y1="13" x2="8" y2="13"></line>
                        <line x1="16" y1="17" x2="8" y2="17"></line>
                        <polyline points="10 9 9 9 8 9"></polyline>
                    </svg>
                    <div>No print history found on this device.</div>
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    {jobs.map((job) => (
                        <div key={job.jobId} className="summary-box" style={{ marginBottom: 0, padding: '16px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
                                <div style={{ fontWeight: 600, fontSize: '16px', wordBreak: 'break-all', paddingRight: '12px' }}>
                                    {job.fileName}
                                </div>
                                <div className={`status-badge status-${job.status}`} style={{ fontSize: '11px', whiteSpace: 'nowrap' }}>
                                    {job.status.replace(/_/g, ' ')}
                                </div>
                            </div>

                            <div style={{ fontSize: '13px', color: '#666', marginBottom: '12px' }}>
                                {formatDate(job.createdAt)}
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '14px' }}>
                                <div>
                                    <span style={{ color: '#666' }}>Pages: </span>
                                    {job.pages} (x{job.copies || 1})
                                </div>
                                <div>
                                    <span style={{ color: '#666' }}>Type: </span>
                                    {job.printType === 'bw' ? 'B&W' : 'Color'}, {job.sided === 'double' ? 'Double' : 'Single'}
                                </div>
                                <div>
                                    <span style={{ color: '#666' }}>Amount: </span>
                                    {'\u20B9'}{job.totalAmount}
                                </div>
                                <div>
                                    <span style={{ color: '#666' }}>ID: </span>
                                    <span style={{ fontFamily: 'monospace' }}>{job.jobId?.slice(0, 8).toUpperCase()}</span>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            <button className="btn" onClick={onBack} style={{ marginTop: '24px' }}>
                Back to Home
            </button>
        </div>
    );
}

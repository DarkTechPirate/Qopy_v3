import { useRef, useState, useCallback } from 'react';
import { uploadPDF } from '../api';

export default function Upload({ onDone, onError }) {
  const fileRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);

  const handleFile = useCallback(async (file) => {
    if (!file) return;
    if (file.type !== 'application/pdf') {
      onError('Only PDF files are supported.');
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      onError('File too large. Maximum size is 50MB.');
      return;
    }

    onError(null);
    setUploading(true);
    try {
      const data = await uploadPDF(file);
      onDone(data);
    } catch (err) {
      onError(err.message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }, [onDone, onError]);

  return (
    <div>
      <h2 className="screen-title">Upload Your Document</h2>

      <div
        className={`upload-zone${dragging ? ' dragover' : ''}`}
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length > 0) handleFile(e.dataTransfer.files[0]);
        }}
      >
        <div className="upload-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </div>
        <div className="upload-label">Click or drag PDF here</div>
        <div className="upload-hint">PDF files only &middot; Max 50MB</div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="application/pdf"
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files.length > 0) handleFile(e.target.files[0]);
        }}
      />

      {uploading && (
        <div className="loading-msg">
          <span className="loader" />
          Uploading and analyzing...
        </div>
      )}
    </div>
  );
}

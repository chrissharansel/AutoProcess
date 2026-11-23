import { useEffect, useState } from 'react';
import api, { errMsg } from '../lib/api';
import { Spinner, ErrorBox } from '../lib/ui';

/** Original-document preview kept beside the extracted data. PDFs use the browser's viewer (page + zoom via URL parameters); images scale in place. */
export default function PdfPreview({ documentId, mimeType, name }: { documentId: string; mimeType: string; name?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [zoom, setZoom] = useState(100);
  const isPdf = mimeType === 'application/pdf';

  useEffect(() => {
    let revoked: string | null = null, live = true;
    setUrl(null); setError(''); setPage(1);
    api.get(`/documents/${documentId}/preview`, { responseType: 'blob' })
      .then(async (r) => {
        if (!live) return;
        revoked = URL.createObjectURL(r.data); setUrl(revoked);
        if (isPdf) { const txt = await (r.data as Blob).text(); setPages((txt.match(/\/Type\s*\/Page[^s]/g) || []).length); }
      })
      .catch(async (e) => {
        let msg = errMsg(e, 'The original document could not be loaded.');
        try { if (e?.response?.data instanceof Blob) msg = JSON.parse(await e.response.data.text()).error || msg; } catch { /* keep msg */ }
        if (live) setError(msg);
      });
    return () => { live = false; if (revoked) URL.revokeObjectURL(revoked); };
  }, [documentId, isPdf]);

  const maxPage = pages || 999;
  return (
    <div className="pdf-pane">
      <div className="spread" style={{ marginBottom: 8 }}>
        <span className="muted" title={name} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }}>{name || 'Original document'}</span>
        <span className="row" style={{ gap: 6 }}>
          {isPdf && <>
            <button className="btn sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} aria-label="Previous page">‹</button>
            <span className="muted" aria-live="polite">Page {page}{pages ? ` / ${pages}` : ''}</span>
            <button className="btn sm" disabled={page >= maxPage} onClick={() => setPage((p) => Math.min(maxPage, p + 1))} aria-label="Next page">›</button>
          </>}
          <button className="btn sm" disabled={zoom <= 50} onClick={() => setZoom((z) => Math.max(50, z - 25))} aria-label="Zoom out">−</button>
          <span className="muted" style={{ minWidth: 40, textAlign: 'center' }}>{zoom}%</span>
          <button className="btn sm" disabled={zoom >= 300} onClick={() => setZoom((z) => Math.min(300, z + 25))} aria-label="Zoom in">+</button>
        </span>
      </div>
      {error ? <ErrorBox>{error}</ErrorBox> : !url ? <div className="empty"><Spinner label="Loading document…" /></div> : isPdf ? (
        <iframe key={`${page}-${zoom}`} className="pdf-frame" title="Original PDF" src={`${url}#page=${page}&zoom=${zoom}`} />
      ) : (
        <div className="img-wrap"><img src={url} alt={name || 'Uploaded document'} style={{ width: `${zoom}%`, display: 'block' }} /></div>
      )}
    </div>
  );
}

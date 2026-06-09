import { useRef, useState } from "react";
import CandidateTopologyFigure from "./CandidateTopologyFigure.jsx";
import { CANDIDATE_TOPOLOGY_VIEWBOX } from "../figures/candidateTopologyFigureData.js";
import { downloadSvgElementAsPdf } from "../utils/svgPdfExport.js";

export default function CandidateTopologyDemoPage() {
  const svgRef = useRef(null);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState("");

  const downloadPdf = async () => {
    const svg = svgRef.current;
    if (!svg) return;
    setExporting(true);
    setMessage("");
    try {
      const ok = await downloadSvgElementAsPdf(svg, {
        widthPt: CANDIDATE_TOPOLOGY_VIEWBOX.width,
        heightPt: CANDIDATE_TOPOLOGY_VIEWBOX.height,
        filename: "candidate-topology"
      });
      setMessage(ok ? "Đã tải candidate-topology.pdf" : "Xuất PDF thất bại.");
    } catch (err) {
      setMessage(err?.message || "Xuất PDF thất bại.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="candidate-topology-demo">
      <header className="candidate-topology-demo__header">
        <div>
          <h1>Candidate topology figure</h1>
          <p className="muted">
            Tái tạo từ <code>bf1ccfd9-57f2-4e3a-b75a-c37a09f55381.pdf</code> — broadcast / receiver candidates trên
            topology 10 nút.
          </p>
        </div>
        <div className="candidate-topology-demo__actions">
          <button type="button" className="primary-btn" onClick={downloadPdf} disabled={exporting}>
            {exporting ? "Đang xuất…" : "Download PDF"}
          </button>
          <a className="ghost-btn" href="/">
            Về QBR app
          </a>
        </div>
      </header>

      <div className="candidate-topology-demo__canvas">
        <CandidateTopologyFigure ref={svgRef} scale={3} />
      </div>

      {message ? <p className="candidate-topology-demo__message">{message}</p> : null}
    </div>
  );
}

/**
 * Evidence-Backed Video Question Answering (E-VQA Grounding Engine)
 * 
 * Implements arXiv: 2607.11862 (E-VQA) for grounded multi-modal property querying.
 * Associates extracted spatial/trade facts with exact timestamp intervals [startSec, endSec],
 * scene bounding boxes, and frame proof images.
 */

export class VideoEvidenceSegment {
  /**
   * @param {object} params
   * @param {string} params.sourceClip - Video filename (e.g. 'site_walkthrough_clip.mp4')
   * @param {number} params.startSec - Start timestamp in seconds
   * @param {number} params.endSec - End timestamp in seconds
   * @param {string} [params.description] - Description of observed element/action
   * @param {string} [params.keyframePath] - Absolute or relative path to extracted keyframe JPG
   * @param {Array<string>} [params.entities] - Entities visible in this clip (e.g. ['pex_pipe', 'galvanized_drain', 'cleanout'])
   * @param {object} [params.bbox] - Bounding box [ymin, xmin, ymax, xmax] normalized (0-1000)
   * @param {number} [params.confidence=1.0] - Extraction confidence score
   */
  constructor({
    sourceClip,
    startSec,
    endSec,
    description = '',
    keyframePath = null,
    entities = [],
    bbox = null,
    confidence = 1.0
  }) {
    this.id = `evidence-${sourceClip}-${Math.round(startSec)}-${Math.round(endSec)}`;
    this.sourceClip = sourceClip;
    this.startSec = startSec;
    this.endSec = endSec;
    this.description = description;
    this.keyframePath = keyframePath;
    this.entities = entities;
    this.bbox = bbox;
    this.confidence = confidence;
  }

  get formattedTimestamp() {
    const formatTime = (s) => {
      const mins = Math.floor(s / 60);
      const secs = Math.floor(s % 60);
      return `${mins}:${secs.toString().padStart(2, '0')}`;
    };
    return `${formatTime(this.startSec)} - ${formatTime(this.endSec)}`;
  }
}

export class EvidenceGroundingEngine {
  constructor(propertyId = 'demo-property') {
    this.propertyId = propertyId;
    this.evidenceIndex = []; // Array<VideoEvidenceSegment>
  }

  /**
   * Index an evidence segment into memory
   * @param {VideoEvidenceSegment|object} segment 
   */
  indexEvidence(segment) {
    const seg = segment instanceof VideoEvidenceSegment ? segment : new VideoEvidenceSegment(segment);
    this.evidenceIndex.push(seg);
    return seg;
  }

  /**
   * Bulk index evidence items
   * @param {Array<object>} segments 
   */
  bulkIndex(segments) {
    if (!Array.isArray(segments)) return [];
    return segments.map(s => this.indexEvidence(s));
  }

  /**
   * Find video evidence segments relevant to a query or entity list
   * @param {object} options
   * @param {string[]} [options.entities] - List of entity names to match
   * @param {string} [options.queryText] - Search query text
   * @param {string} [options.sourceClip] - Filter by specific video clip
   * @returns {VideoEvidenceSegment[]}
   */
  findEvidence({ entities = [], queryText = '', sourceClip = null } = {}) {
    const terms = [
      ...entities.map(e => e.toLowerCase()),
      ...(queryText ? queryText.toLowerCase().split(/\s+/) : [])
    ].filter(Boolean);

    return this.evidenceIndex.filter(seg => {
      if (sourceClip && seg.sourceClip !== sourceClip) return false;
      if (terms.length === 0) return true;

      const segText = `${seg.description} ${seg.entities.join(' ')} ${seg.sourceClip}`.toLowerCase();
      return terms.some(t => segText.includes(t));
    }).sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Format a grounded QA response with explicit video citations
   * @param {string} answerText 
   * @param {VideoEvidenceSegment[]} evidenceList 
   * @returns {string} Markdown text with evidence citations
   */
  formatGroundedAnswer(answerText, evidenceList = []) {
    if (!evidenceList || evidenceList.length === 0) {
      return answerText;
    }

    let out = `${answerText}\n\n### 📹 Verified Video Grounding Evidence\n`;
    for (const [idx, ev] of evidenceList.slice(0, 4).entries()) {
      out += `\n**[Proof ${idx + 1}]** \`${ev.sourceClip}\` at **\`${ev.formattedTimestamp}\`** (Confidence: ${(ev.confidence * 100).toFixed(0)}%)\n`;
      if (ev.description) {
        out += `> ${ev.description}\n`;
      }
      if (ev.keyframePath) {
        out += `* *Keyframe Reference:* \`${ev.keyframePath}\`\n`;
      }
    }
    return out;
  }

  /**
   * Convert to JSON representation
   */
  toJSON() {
    return {
      propertyId: this.propertyId,
      evidence: this.evidenceIndex
    };
  }

  /**
   * Hydrate from JSON
   */
  static fromJSON(json) {
    const engine = new EvidenceGroundingEngine(json.propertyId || 'demo-property');
    if (Array.isArray(json.evidence)) {
      for (const e of json.evidence) engine.indexEvidence(e);
    }
    return engine;
  }
}

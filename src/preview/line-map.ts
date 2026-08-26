/**
 * Line-number mapping for scroll sync correction.
 *
 * When preprocessors change the line count of markdown source before
 * markdown-it tokenization, token `.map` values (used by VS Code for
 * `data-line` scroll sync attributes) reference preprocessed line numbers
 * instead of original source line numbers. LineMap tracks this correspondence
 * and remaps preprocessed line numbers back to original ones.
 *
 * Invariant: segments are sorted by preprocessedStart and non-overlapping.
 * Keep in sync with preprocess-with-map.ts which builds these maps.
 */

export interface LineMapSegment {
  /** First preprocessed line this segment covers (inclusive) */
  preprocessedStart: number;
  /** Corresponding original line number */
  originalStart: number;
  /** Number of preprocessed lines with 1:1 correspondence */
  length: number;
}

/**
 * A single-step line map that remaps preprocessed line numbers back to
 * the input line numbers of that preprocessing step.
 */
class SingleLineMap {
  readonly segments: readonly LineMapSegment[];

  constructor(segments: LineMapSegment[]) {
    this.segments = segments;
  }

  /**
   * Remap a preprocessed line number back to the input line number.
   * Uses binary search over segments. Lines in gaps between segments
   * clamp to the nearest preceding input line.
   */
  remap(preprocessedLine: number): number {
    const segs = this.segments;
    if (segs.length === 0) return preprocessedLine;

    let lo = 0;
    let hi = segs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const seg = segs[mid];
      if (preprocessedLine < seg.preprocessedStart) {
        hi = mid - 1;
      } else if (preprocessedLine >= seg.preprocessedStart + seg.length) {
        lo = mid + 1;
      } else {
        return seg.originalStart + (preprocessedLine - seg.preprocessedStart);
      }
    }

    if (hi < 0) return segs[0].originalStart;
    const seg = segs[hi];
    return seg.originalStart + seg.length;
  }
}

/**
 * Composable line-number mapping. Chains multiple SingleLineMaps so that
 * remap(n) applies each step's mapping in reverse order (last preprocessor
 * first, then second-to-last, etc.) to recover the original source line.
 */
export class LineMap {
  private readonly maps: readonly SingleLineMap[];

  private static readonly IDENTITY = new LineMap([]);

  private constructor(maps: SingleLineMap[]) {
    this.maps = maps;
  }

  /** Identity map — no line number changes. */
  static identity(): LineMap {
    return LineMap.IDENTITY;
  }

  /** Create a LineMap from a single set of segments. */
  static fromSegments(segments: LineMapSegment[]): LineMap {
    if (segments.length === 0) return LineMap.IDENTITY;
    return new LineMap([new SingleLineMap(segments)]);
  }

  /**
   * Create an exact map from preprocessed line-boundary indices to input
   * line-boundary indices. Adjacent 1:1 mappings are compressed into segments;
   * repeated or skipped source lines remain explicit segment boundaries.
   */
  static fromLineMappings(mappings: readonly number[]): LineMap {
    if (mappings.length === 0 || mappings.every((original, line) => original === line)) {
      return LineMap.IDENTITY;
    }

    const segments: LineMapSegment[] = [];
    let segmentStart = 0;
    for (let line = 1; line <= mappings.length; line++) {
      if (line < mappings.length && mappings[line] === mappings[line - 1] + 1) continue;
      segments.push({
        preprocessedStart: segmentStart,
        originalStart: mappings[segmentStart],
        length: line - segmentStart,
      });
      segmentStart = line;
    }
    return new LineMap([new SingleLineMap(segments)]);
  }

  /** True when no remapping is needed. */
  get isIdentity(): boolean {
    return this.maps.length === 0;
  }

  /**
   * Remap a preprocessed line number back to the original source line number.
   * Chains through all maps in reverse order.
   */
  remap(preprocessedLine: number): number {
    let line = preprocessedLine;
    for (let i = this.maps.length - 1; i >= 0; i--) {
      line = this.maps[i].remap(line);
    }
    return line;
  }

  /**
   * Chain two maps: `first` then `second`. The resulting map remaps through
   * `second` first (undoing the last preprocessing step), then through `first`.
   */
  static chain(first: LineMap, second: LineMap): LineMap {
    if (first.isIdentity) return second;
    if (second.isIdentity) return first;
    const combined = [...first.maps, ...second.maps];
    return new LineMap(combined);
  }
}

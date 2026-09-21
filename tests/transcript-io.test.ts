import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TranscriptError, workingOf } from '../src/transcript/apply.js';
import {
  TRANSCRIPT_DOCUMENT_KIND,
  emptyDocument,
  parseTranscriptDocument,
  readTranscriptDocument,
  withStage,
  writeTranscriptDocument,
  type TranscriptDocument,
} from '../src/transcript/io.js';
import type { Edit, Transcript } from '../src/transcript/types.js';

function edit(raw: string, rawStart: number, rawEnd: number, replacement: string): Edit {
  return {
    id: 'e1',
    source: 'human',
    rawStart,
    rawEnd,
    original: raw.slice(rawStart, rawEnd),
    replacement,
    reason: 'unit-test',
    accepted: true,
  };
}

function transcript(): Transcript {
  return {
    raw: 'cat sat mit',
    segments: [
      { start: 0, end: 1, text: 'cat', score: 0.9 },
      { start: 1, end: 2, text: 'sat', score: 0.8 },
      { start: 2, end: 3, text: 'mit', score: 0.5 },
    ],
    edits: [edit('cat sat mit', 8, 11, 'mat')],
  };
}

/** A fully populated envelope, exercising every payload type. */
function fullDocument(): TranscriptDocument {
  const doc = emptyDocument(transcript());
  const withAudio: TranscriptDocument = {
    ...doc,
    asrModel: 'parakeet-tdt-0.6b-v2-int8',
    audio: {
      path: 'samples/synthetic.wav',
      sha256: 'a'.repeat(64),
      sourceDurationSec: 4.2,
      durationSec: 3.1,
      sampleRate: 16000,
      channels: 1,
      denoised: false,
      trim: { segments: [{ outStart: 0, outEnd: 3.1, srcStart: 1.1, srcEnd: 4.2 }] },
    },
  };
  const withGate: TranscriptDocument = {
    ...withAudio,
    gate: {
      pass: true,
      checks: [
        { id: 'words-per-second', value: 2.4, threshold: 1.5, pass: true },
        { id: 'mean-token-score', value: -0.4, threshold: -1.0, pass: true },
        { id: 'glossary-hit-rate', value: 4.0, threshold: 3.0, pass: true },
      ],
    },
  };
  const withRetrieval: TranscriptDocument = {
    ...withGate,
    retrieval: {
      k: 50,
      terms: [
        { id: 'cataract', score: 6.5, floor: false },
        { id: 'od', score: 1.0, floor: true },
      ],
      hits: 4,
      shortCircuit: false,
    },
  };
  return withStage(
    {
      ...withRetrieval,
      droppedEdits: [
        { guard: 'glossary', original: 'mitten', replacement: 'mat', termId: null, distance: 1 },
      ],
    },
    { stage: 'transcribe', durationMs: 812, ok: true },
  );
}

function roundTrip(doc: TranscriptDocument): TranscriptDocument {
  return parseTranscriptDocument(JSON.parse(JSON.stringify(doc)));
}

describe('TranscriptDocument', () => {
  it('parses back to deep equality after a JSON round-trip', () => {
    const doc = fullDocument();

    expect(roundTrip(doc)).toEqual(doc);
  });

  it('keep `working` and the offset map identical across a round-trip', () => {
    const doc = fullDocument();
    const before = workingOf(doc.transcript);
    const after = workingOf(roundTrip(doc).transcript);

    expect(after.working).toBe(before.working);
    for (let i = 0; i <= before.working.length; i++) {
      expect(after.mapToRaw(i), `working offset ${i}`).toBe(before.mapToRaw(i));
    }
  });

  it('emptyDocument leaves every stage-owned field at its default', () => {
    const doc = emptyDocument(transcript());

    expect(doc.kind).toBe(TRANSCRIPT_DOCUMENT_KIND);
    expect(doc.version).toBe(1);
    expect(doc.audio).toBeNull();
    expect(doc.asrModel).toBeNull();
    expect(doc.gate).toBeNull();
    expect(doc.retrieval).toBeNull();
    expect(doc.droppedEdits).toEqual([]);
    expect(doc.stages).toEqual([]);
  });

  it('withStage appends run records without mutating the input', () => {
    const doc = emptyDocument(transcript());
    const next = withStage(doc, { stage: 'transcribe', durationMs: 10, ok: true });

    expect(doc.stages).toEqual([]);
    expect(next.stages).toEqual([{ stage: 'transcribe', durationMs: 10, ok: true }]);
    expect(withStage(next, { stage: 'retrieve', durationMs: 5, ok: true }).stages).toHaveLength(2);
  });

  it('write creates parent directories and read parses the file back', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ophtha-transcript-io-')), 'a', 'b', 'x.transcript.json');

    writeTranscriptDocument(path, emptyDocument(transcript()));
    expect(readTranscriptDocument(path)).toEqual(emptyDocument(transcript()));
  });
});

describe('parseTranscriptDocument', () => {
  it('rejects the wrong kind or version before anything else', () => {
    const doc = JSON.parse(JSON.stringify(fullDocument()));
    expect(() => parseTranscriptDocument({ ...doc, kind: 'ophtha-scribe/draft' })).toThrow(
      /kind/,
    );
    expect(() => parseTranscriptDocument({ ...doc, version: 2 })).toThrow(/version/);
  });

  it('rejects a non-object root and missing payloads', () => {
    expect(() => parseTranscriptDocument(null)).toThrow(TranscriptError);
    expect(() => parseTranscriptDocument('nope')).toThrow(TranscriptError);
    expect(() => parseTranscriptDocument({})).toThrow(TranscriptError);
  });

  it('names the offending index, never the offending text', () => {
    const broken = (mutate: (doc: Record<string, unknown>) => void): void => {
      const doc = JSON.parse(JSON.stringify(fullDocument())) as Record<string, unknown>;
      mutate(doc);
      expect(() => parseTranscriptDocument(doc)).toThrow(TranscriptError);
    };

    broken((doc) => {
      const t = doc['transcript'] as Record<string, unknown>;
      const seg = (t['segments'] as unknown[])[1];
      (seg as Record<string, unknown>)['score'] = 'high';
    });
    broken((doc) => {
      const t = doc['transcript'] as Record<string, unknown>;
      const editObj = (t['edits'] as unknown[])[0];
      (editObj as Record<string, unknown>)['source'] = 'alien';
    });
    broken((doc) => {
      const gate = doc['gate'] as Record<string, unknown>;
      const check = (gate['checks'] as unknown[])[0];
      (check as Record<string, unknown>)['id'] = 'vibes';
    });
    broken((doc) => {
      const audio = doc['audio'] as Record<string, unknown>;
      delete audio['sha256'];
    });
    broken((doc) => {
      const stages = doc['stages'] as unknown[];
      (stages[0] as Record<string, unknown>)['ok'] = 'yes';
    });
    broken((doc) => {
      const dropped = doc['droppedEdits'] as unknown[];
      (dropped[0] as Record<string, unknown>)['guard'] = 'vibes';
    });
  });
});

import crypto from 'node:crypto';
import fs from 'node:fs';
import { writeFileAtomic } from '../utils/fsAtomic.ts';

export interface NgTokenizerModel {
  format: 'NG-ILMF-BPE-V1';
  spec: string;
  normalization: 'NFC';
  bosToken: string;
  eosToken: string;
  padToken: string;
  unkToken: string;
  vocab: Record<string, number>;
  merges: Array<[string, string]>;
  vocabSize: number;
  createdAt: string;
}

const SPECIAL_TOKENS = ['<|ng_pad|>', '<|ng_bos|>', '<|ng_eos|>', '<|ng_unk|>'] as const;

function getByteTokens(): string[] {
  const list: string[] = [];
  for (let b = 0; b < 256; b++) {
    list.push(`<0x${b.toString(16).padStart(2, '0')}>`);
  }
  return list;
}

function textToByteSymbols(word: string): string[] {
  const bytes = Buffer.from(word.normalize('NFC'), 'utf-8');
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    out.push(`<0x${bytes[i].toString(16).padStart(2, '0')}>`);
  }
  return out;
}

function applyPairMerge(tokens: string[], pairA: string, pairB: string, merged: string): string[] {
  if (tokens.length < 2) return tokens;
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (i < tokens.length - 1 && tokens[i] === pairA && tokens[i + 1] === pairB) {
      out.push(merged);
      i += 2;
    } else {
      out.push(tokens[i]);
      i += 1;
    }
  }
  return out;
}

/**
 * Trains a real deterministic Unicode-NFC Byte-Fallback BPE tokenizer over the supplied corpus lines.
 */
export function trainTokenizerFromCorpus(
  corpusLines: string[],
  options: { spec?: string; targetMerges?: number } = {},
): NgTokenizerModel {
  const spec = (options.spec ?? 'NG-BPE-BYTE-V1').trim() || 'NG-BPE-BYTE-V1';
  const targetMerges = Math.max(0, Math.min(Number(options.targetMerges ?? 128), 2048));

  const vocab: Record<string, number> = {};
  let nextId = 0;
  for (const tok of SPECIAL_TOKENS) {
    vocab[tok] = nextId++;
  }
  for (const byteTok of getByteTokens()) {
    vocab[byteTok] = nextId++;
  }

  // Split corpus into whitespace-preserving chunks so decoding is lossless
  const wordCounts = new Map<string, number>();
  for (const line of corpusLines) {
    const normalized = line.normalize('NFC');
    const chunks = normalized.match(/\S+|\s+/g) ?? [];
    for (const chunk of chunks) {
      wordCounts.set(chunk, (wordCounts.get(chunk) ?? 0) + 1);
    }
  }

  const wordSeqs: Array<{ symbols: string[]; count: number }> = [];
  for (const [chunk, count] of wordCounts.entries()) {
    const symbols = textToByteSymbols(chunk);
    if (symbols.length > 1) {
      wordSeqs.push({ symbols, count });
    }
  }

  const merges: Array<[string, string]> = [];
  for (let step = 0; step < targetMerges && wordSeqs.length > 0; step++) {
    const pairFreq = new Map<string, number>();
    for (const entry of wordSeqs) {
      for (let i = 0; i < entry.symbols.length - 1; i++) {
        const key = `${entry.symbols[i]}\u0000${entry.symbols[i + 1]}`;
        pairFreq.set(key, (pairFreq.get(key) ?? 0) + entry.count);
      }
    }

    let bestKey = '';
    let bestCount = 1; // Require frequency >= 2 to form a merge
    for (const [k, count] of pairFreq.entries()) {
      if (count > bestCount || (count === bestCount && k < bestKey)) {
        bestCount = count;
        bestKey = k;
      }
    }

    if (!bestKey) break;
    const [pairA, pairB] = bestKey.split('\u0000');
    const mergedSymbol = `${pairA}+${pairB}`;
    merges.push([pairA, pairB]);
    if (!(mergedSymbol in vocab)) {
      vocab[mergedSymbol] = nextId++;
    }

    for (const entry of wordSeqs) {
      entry.symbols = applyPairMerge(entry.symbols, pairA, pairB, mergedSymbol);
    }
  }

  return {
    format: 'NG-ILMF-BPE-V1',
    spec,
    normalization: 'NFC',
    bosToken: '<|ng_bos|>',
    eosToken: '<|ng_eos|>',
    padToken: '<|ng_pad|>',
    unkToken: '<|ng_unk|>',
    vocab,
    merges,
    vocabSize: Object.keys(vocab).length,
    createdAt: new Date().toISOString(),
  };
}

export function encodeText(
  tokenizer: NgTokenizerModel,
  text: string,
  options: { addBos?: boolean; addEos?: boolean } = {},
): number[] {
  const ids: number[] = [];
  if (options.addBos) {
    ids.push(tokenizer.vocab[tokenizer.bosToken] ?? 1);
  }

  const normalized = text.normalize(tokenizer.normalization || 'NFC');
  const chunks = normalized.match(/\S+|\s+/g) ?? (normalized ? [normalized] : []);
  const unkId = tokenizer.vocab[tokenizer.unkToken] ?? 3;

  const mergeRank = new Map<string, number>();
  for (let idx = 0; idx < tokenizer.merges.length; idx++) {
    const [a, b] = tokenizer.merges[idx];
    mergeRank.set(`${a}\u0000${b}`, idx);
  }

  for (const chunk of chunks) {
    let symbols = textToByteSymbols(chunk);
    while (symbols.length >= 2) {
      let bestIdx = -1;
      let bestRank = Number.POSITIVE_INFINITY;
      for (let i = 0; i < symbols.length - 1; i++) {
        const r = mergeRank.get(`${symbols[i]}\u0000${symbols[i + 1]}`);
        if (r !== undefined && r < bestRank) {
          bestRank = r;
          bestIdx = i;
        }
      }
      if (bestIdx === -1) break;
      const merged = `${symbols[bestIdx]}+${symbols[bestIdx + 1]}`;
      symbols = [
        ...symbols.slice(0, bestIdx),
        merged,
        ...symbols.slice(bestIdx + 2),
      ];
    }

    for (const sym of symbols) {
      ids.push(tokenizer.vocab[sym] ?? unkId);
    }
  }

  if (options.addEos) {
    ids.push(tokenizer.vocab[tokenizer.eosToken] ?? 2);
  }
  return ids;
}

export function decodeTokens(
  tokenizer: NgTokenizerModel,
  tokenIds: number[],
  options: { skipSpecialTokens?: boolean } = { skipSpecialTokens: true },
): string {
  const idToSym = new Map<number, string>();
  for (const [sym, id] of Object.entries(tokenizer.vocab)) {
    idToSym.set(id, sym);
  }
  const specialSet = new Set<string>(SPECIAL_TOKENS);
  const bytes: number[] = [];

  const pushSymbolBytes = (sym: string) => {
    const parts = sym.split('+');
    for (const part of parts) {
      const m = part.match(/^<0x([0-9a-f]{2})>$/i);
      if (m) {
        bytes.push(Number.parseInt(m[1], 16));
      }
    }
  };

  for (const id of tokenIds) {
    const sym = idToSym.get(id);
    if (!sym) continue;
    if (specialSet.has(sym)) {
      if (!options.skipSpecialTokens) {
        bytes.push(...Buffer.from(sym, 'utf-8'));
      }
      continue;
    }
    pushSymbolBytes(sym);
  }

  return Buffer.from(bytes).toString('utf-8');
}

export function saveTokenizerFile(filePath: string, tokenizer: NgTokenizerModel): {
  filePath: string;
  sha256: string;
  sizeBytes: number;
} {
  const json = JSON.stringify(tokenizer, null, 2);
  writeFileAtomic(filePath, json, 'utf-8');
  const buf = Buffer.from(json, 'utf-8');
  return {
    filePath,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    sizeBytes: buf.length,
  };
}

export function loadTokenizerFile(filePath: string): NgTokenizerModel {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<NgTokenizerModel>;
  if (
    parsed.format !== 'NG-ILMF-BPE-V1' ||
    !parsed.vocab ||
    typeof parsed.vocab !== 'object' ||
    !Array.isArray(parsed.merges)
  ) {
    throw new Error(`Invalid or corrupted NG-ILMF tokenizer file: ${filePath}`);
  }
  return parsed as NgTokenizerModel;
}

export function inspectTokenizerFile(filePath: string): {
  valid: boolean;
  spec: string;
  vocabSize: number;
  mergesCount: number;
  roundTripPassed: boolean;
  sha256: string;
  reason?: string;
} {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return {
      valid: false,
      spec: '',
      vocabSize: 0,
      mergesCount: 0,
      roundTripPassed: false,
      sha256: '',
      reason: 'Tokenizer file missing on disk',
    };
  }
  try {
    const buf = fs.readFileSync(filePath);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const tok = loadTokenizerFile(filePath);
    const probeText = 'NG-ILMF العربية Sovereign Mind Verification 2026!';
    const encoded = encodeText(tok, probeText, { addBos: true, addEos: true });
    const decoded = decodeTokens(tok, encoded, { skipSpecialTokens: true });
    const roundTripPassed = decoded === probeText.normalize('NFC');
    return {
      valid: tok.vocabSize >= 260 && roundTripPassed,
      spec: tok.spec,
      vocabSize: tok.vocabSize,
      mergesCount: tok.merges.length,
      roundTripPassed,
      sha256,
      reason: roundTripPassed ? undefined : 'Tokenizer encode/decode round-trip mismatch',
    };
  } catch (err) {
    return {
      valid: false,
      spec: '',
      vocabSize: 0,
      mergesCount: 0,
      roundTripPassed: false,
      sha256: '',
      reason: err instanceof Error ? err.message : 'Failed to parse tokenizer.json',
    };
  }
}

export function tokenizeDatasetLines(
  tokenizer: NgTokenizerModel,
  lines: string[],
): {
  totalLines: number;
  totalTokens: number;
  avgTokensPerLine: number;
  unkTokens: number;
  unkRate: number;
} {
  const unkId = tokenizer.vocab[tokenizer.unkToken] ?? 3;
  let totalTokens = 0;
  let unkTokens = 0;

  for (const line of lines) {
    const ids = encodeText(tokenizer, line, { addBos: true, addEos: true });
    totalTokens += ids.length;
    for (const id of ids) {
      if (id === unkId) unkTokens += 1;
    }
  }

  return {
    totalLines: lines.length,
    totalTokens,
    avgTokensPerLine: lines.length > 0 ? Number((totalTokens / lines.length).toFixed(2)) : 0,
    unkTokens,
    unkRate: totalTokens > 0 ? Number((unkTokens / totalTokens).toFixed(6)) : 0,
  };
}

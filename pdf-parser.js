// The legacy build includes compatibility shims required by older Chromium
// runtimes (notably Uint8Array#toHex used by PDF.js 5).
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * pdf-parser.js — PDF text extraction + invoice detection
 * v3 — Fixes French number parsing by separating:
 *   - "formatted numbers" (with comma-decimal) = real data values
 *   - plain integers (no comma) = TVA rate or text (ignored for column mapping)
 */

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

// ─── PUBLIC ENTRY POINT ────────────────────────────────────────────────────
export async function parsePdf(arrayBuffer, onProgress) {
  onProgress(5, 'Chargement du PDF…');
  const pdf        = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const totalPages = pdf.numPages;
  onProgress(10, `PDF chargé — ${totalPages} page(s)`);

  let lineTexts = [];

  for (let p = 1; p <= totalPages; p++) {
    const page    = await pdf.getPage(p);
    const content = await page.getTextContent({ normalizeWhitespace: false });

    // Group text items by Y position (bucket of 4pts) → reconstruct visual lines
    const yMap = {};
    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      const bucket = Math.round(item.transform[5] / 4) * 4;
      if (!yMap[bucket]) yMap[bucket] = [];
      yMap[bucket].push({ x: item.transform[4], text: item.str });
    }

    const sortedYs = Object.keys(yMap).map(Number).sort((a, b) => b - a);
    for (const yb of sortedYs) {
      const merged = yMap[yb].sort((a, b) => a.x - b.x).map(i => i.text).join(' ').trim();
      if (merged) lineTexts.push(merged);
    }

    onProgress(10 + Math.round((p / totalPages) * 40), `Page ${p}/${totalPages} extraite`);
  }

  onProgress(55, 'Détection des factures…');

  const chunks = splitInvoices(lineTexts);
  onProgress(65, `${chunks.length} facture(s) détectée(s)`);

  const invoices = [];
  for (let i = 0; i < chunks.length; i++) {
    const inv = parseInvoice(chunks[i]);
    invoices.push(inv);
    onProgress(
      65 + Math.round(((i + 1) / chunks.length) * 30),
      `Facture N°${inv.piece} — ${inv.lines.length} ligne(s) produit`
    );
  }

  onProgress(100, 'Extraction terminée');
  return invoices;
}

// ─── SPLIT BY "Facture N°" MARKER ─────────────────────────────────────────
function splitInvoices(lines) {
  const chunks = [];
  let cur = [];
  let found = false;

  for (const line of lines) {
    // Normal case: "Facture N° : 1300" / "Facture N:1300" — number on the same line.
    // Scrambled case (seen in some multi-invoice PDFs, e.g. consolidated exports):
    // the text layer emits the bare label "Facture N :" on its own line, with the
    // actual invoice number appearing several lines further down. We must still
    // treat that bare label as a new-invoice boundary, or every invoice in the
    // file collapses into a single chunk.
    if (/Facture\s+N\s*[°o]?\s*[:\-]?\s*\d/i.test(line) ||
        /Facture\s*N[°o]\s*:/i.test(line) ||
        /^\s*Facture\s*N\s*[°o]?\s*[:\-]?\s*$/i.test(line)) {
      if (found && cur.length) chunks.push(cur);
      cur   = [line];
      found = true;
    } else if (found) {
      cur.push(line);
    }
  }
  if (cur.length) chunks.push(cur);
  return chunks.length ? chunks : [lines];
}

// ─── PARSE ONE INVOICE CHUNK ───────────────────────────────────────────────
function parseInvoice(lines) {
  const inv = {
    piece: '', date: '', clientCode: '', clientName: '',
    lines: [], total_mht: 0, total_mtva: 0,
    montant_timbre: 0, total_mttc: 0,
    modePaiement: '', vatBreakdown: [], rawLines: lines,
  };

  // Header
  for (const line of lines) {
    const pm = line.match(/Facture\s+N\s*[°o]?\s*[:\-]?\s*(\d+)/i);
    if (pm && !inv.piece) inv.piece = pm[1].trim();

    const dm = line.match(/Date\s*[:\-]\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
    if (dm && !inv.date)
      inv.date = `${parseInt(dm[1])}/${parseInt(dm[2])}/${dm[3]}`;
  }

  // Client
  for (const line of lines) {
    const cm = line.match(/Client\s*[:\-]\s*(\S+)/i);
    if (cm && !inv.clientCode) inv.clientCode = cm[1].trim();

    const rm = line.match(/Raison\s+sociale?\s*[:\-]\s*(.+)/i);
    if (rm && !inv.clientName) inv.clientName = rm[1].trim();

    const modeMatch = line.match(/Mode\s*de\s*Paiement\s*[:\-]\s*(.+)/i);
    if (modeMatch && !inv.modePaiement) inv.modePaiement = modeMatch[1].trim();
  }

  // ── Fallback: scrambled label/value layout ─────────────────────────────
  // Some consolidated PDFs emit "Facture N :" / "Client :" / etc. as bare
  // labels with their values landing on unrelated lines elsewhere in the
  // chunk (a pdf.js text-ordering artifact, not a data problem). When the
  // inline "label: value" match above fails, fall back to positional
  // anchors that are consistent in this invoice template:
  //   - the client code is a bare line like "C179" / "C043"
  //   - the client name is the line immediately after it
  //   - the invoice piece number is a bare 3–6 digit line that sits right
  //     before the "N Code ... MTVA" table-header marker line
  if (!inv.clientCode) {
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*C\s?\d{2,6}\s*$/i.test(lines[i])) {
        inv.clientCode = lines[i].trim();
        if (!inv.clientName && lines[i + 1] && /[A-Za-zÀ-ÿ]/.test(lines[i + 1]) &&
            !/^\d/.test(lines[i + 1].trim())) {
          inv.clientName = lines[i + 1].trim();
        }
        break;
      }
    }
  }

  if (!inv.piece) {
    for (let i = 1; i < lines.length; i++) {
      if (/N\s*Code\b.*MTVA/i.test(lines[i]) || /^\s*N\s*Code\s*$/i.test(lines[i])) {
        for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
          const bare = lines[j].trim();
          if (/^\d{3,6}$/.test(bare)) { inv.piece = bare; break; }
        }
        if (inv.piece) break;
      }
    }
  }

  parseTotals(lines, inv);
  parseVatBreakdown(lines, inv);
  inv.lines = parseLineItems(lines);

  // Fallback 1: use TVA breakdown rows
  if (inv.lines.length === 0 && inv.vatBreakdown.length > 0) {
    for (const vb of inv.vatBreakdown) {
      if (vb.montant_ht > 0) {
        inv.lines.push({
          code: '', designation: `(TVA ${vb.rate}%)`,
          qty: null, pu: null,
          mht: vb.montant_ht, tva_rate: vb.rate,
          mtva: vb.montant_tva,
          mttc: round2(vb.montant_ht + vb.montant_tva),
          _fromVatBreakdown: true,
        });
      }
    }
  }

  // Fallback 2: single line from total
  if (inv.lines.length === 0 && inv.total_mht > 0) {
    inv.lines.push({
      code: '', designation: '(ligne non détectée)',
      qty: null, pu: null,
      mht: inv.total_mht, tva_rate: 0,
      mtva: inv.total_mtva, mttc: inv.total_mttc,
    });
  }

  return inv;
}

// ─── PARSE LINE ITEMS ──────────────────────────────────────────────────────
function parseLineItems(lines) {
  // Locate table header and end boundary
  let tableStart = -1, tableEnd = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // "D.signation" tolerates PDFs whose custom font encoding mis-decodes
    // accented letters (é → È, Í, etc.) — only the single accented char
    // varies, "signation" itself is plain ASCII and always intact.
    if (tableStart === -1 &&
        /D.signation/i.test(l) &&
        /Q.t.|MHT|MTTC/i.test(l)) {
      tableStart = i + 1;
    }
    if (tableStart !== -1 && i > tableStart &&
        /Total\s*MHT|Arr.t.e|Retenue|Total\s*Qt.|Montant\s*Timb|Mode\s*de/i.test(l)) {
      tableEnd = i;
      break;
    }
  }

  if (tableStart === -1) return fallbackLineItems(lines);

  const tableLines = lines.slice(tableStart, tableEnd);
  const items = [];

  // ── Group physical lines into logical rows ────────────────────────────
  // A row starts with "<row#> <code> ...". Everything up to (not including)
  // the next row-start line belongs to the same logical row. This is needed
  // because some PDFs wrap a long designation onto a second printed line,
  // and in doing so also scatter that row's numeric columns across the
  // wrapped lines (see reconstructRowText below for why simple line
  // concatenation isn't enough).
  const ROW_START_RE = /^\s*\d{1,3}\s+[A-Za-z0-9]/;
  const groups = [];
  let cur = null;
  for (const raw of tableLines) {
    const t = raw.trim();
    if (!t) continue;
    if (ROW_START_RE.test(raw)) {
      if (cur) groups.push(cur);
      cur = [raw];
    } else if (cur) {
      cur.push(raw);
    }
  }
  if (cur) groups.push(cur);

  for (const group of groups) {
    const item = group.length === 1
      ? tryParseRow(group[0])
      : tryParseRow(reconstructRowText(group));
    if (item) items.push(item);
  }

  return items.filter(it => it.mht > 0);
}

// ─── RECONSTRUCT A ROW SPLIT ACROSS MULTIPLE PHYSICAL LINES ───────────────
// Observed pattern in some PDFs: when a designation wraps to a second
// printed line, the row's rightmost columns (MTVA, MTTC) stay attached to
// the FIRST physical line (with the start of the designation), while the
// middle columns (Unit, Qté, P.U, MHT, TVA%) land on a LATER physical line
// that begins with the unit token (UN, U, KG, …). A naive top-to-bottom
// join would therefore read the numbers in the wrong column order (e.g.
// mistaking MTVA for MHT). We detect the "unit line" and place its numbers
// BEFORE the first line's trailing numbers, restoring the true left-to-
// right column order: Qté, P.U, MHT, [TVA%], [MTVA], MTTC.
const UNIT_LINE_RE = /^\s*(UN|U|KG|L|T|M2?|PCE|PCS|QX|BOX|SAC|SCS)\b/i;

function reconstructRowText(group) {
  const unitIdx = group.findIndex((l, i) => i > 0 && UNIT_LINE_RE.test(l.trim()));
  if (unitIdx === -1) return group.join(' ');

  const headLine = group[0];
  const unitLine = group[unitIdx];
  const otherLines = group.filter((_, i) => i !== 0 && i !== unitIdx);

  // Split the head line into "everything before its own formatted numbers"
  // (row#, code, start of designation) and "its own trailing numbers"
  // (MTVA / MTTC), so the unit line's numbers can be inserted between them.
  const headDesignation = headLine.replace(/\d{1,3}(?:\s\d{3})*,\d{1,2}/g, '').trim();
  const headNums = (headLine.match(/\d{1,3}(?:\s\d{3})*,\d{1,2}/g) || []).join(' ');

  // Two spaces (not one) between segments: the formatted-number regex only
  // treats a SINGLE space as a thousands-separator, so this stops a bare
  // trailing digit (e.g. the TVA rate "19") from fusing with the next
  // segment's number (e.g. "190,00") into a bogus "19 190,00" = 19190.
  return [headDesignation, ...otherLines, unitLine, headNums].join('  ');
}

// ─── PARSE ONE PRODUCT ROW ─────────────────────────────────────────────────
/**
 * The key insight:
 *   - "Formatted" numbers (have a comma decimal): 10,00 / 1 800,00 / 18 000,00
 *     → these are the DATA columns: Qté, P.U, MHT, MTVA, MTTC
 *   - Plain integers (no comma): the TVA rate (0, 7, 9, 17, 19…)
 *     or digits embedded in designation text ("SON 50 KG" → 50, ignored)
 *
 * By using ONLY formatted numbers for column mapping we avoid
 * the "50" in "SON 50 KG" and the row number "1" / "2" polluting results.
 *
 * Example row 1 (TVA 0%):
 *   "1 S001 SON 50 KG UN 10,00 1 800,00 18 000,00 0% 18 000,00"
 *   fmtNums = [10, 1800, 18000, 18000]   tvaRate = 0
 *   → qty=10, pu=1800, mht=18000, mtva=0, mttc=18000  ✓
 *
 * Example row 2 (TVA 19%):
 *   "2 P001 PRESTATION ET UN 10,00 100,00 1 000,00 19 190,00 1 190,00"
 *   fmtNums = [10, 100, 1000, 190, 1190]  tvaRate = 19
 *   → qty=10, pu=100, mht=1000, mtva=190, mttc=1190  ✓
 */
function tryParseRow(line) {
  // Must start with a row number (1–3 digits then space)
  if (!/^\s*\d{1,3}\s/.test(line)) return null;
  if (/^(Total|Arrêt|Montant|Mode|Facture|Client|Date|RC\b|NIF|ART|NIS)/i.test(line.trim())) return null;

  // ── Strip leading row number ──────────────────────────────────────────────
  let rest = line.replace(/^\s*\d{1,3}\s+/, '');

  // ── Extract product code (first alphanumeric token) ──────────────────────
  let code = '';
  const codeM = rest.match(/^([A-Za-z]\w*)\s+/);
  if (codeM) { code = codeM[1]; rest = rest.slice(codeM[0].length); }

  // ── Find TVA rate ─────────────────────────────────────────────────────────
  //   Pattern A: explicit "0%" or "19%"
  //   Pattern B: standalone integer ≤ 50 that is NOT inside a formatted number
  let tvaRate = 0;
  const tvaPctM = rest.match(/\b(\d{1,2})\s*%/);
  if (tvaPctM) {
    tvaRate = parseInt(tvaPctM[1]);
  } else {
    // Remove all formatted numbers, then look for remaining small integers
    const stripped = rest.replace(/\d{1,3}(?:\s\d{3})*,\d{1,2}/g, '');
    const intMs    = stripped.match(/\b(\d{1,2})\b/g) || [];
    for (const m of intMs) {
      const v = parseInt(m);
      if (v >= 0 && v <= 50) {
        tvaRate = v;
        // Remove just this bare digit (not digits inside a formatted number,
        // which this regex never matches anyway) so it doesn't end up
        // looking like part of the designation text.
        rest = rest.replace(new RegExp('\\b' + m + '\\b(?!\\d|,\\d)'), '');
        break;
      }
    }
  }

  // ── Extract ONLY formatted French numbers (with comma-decimal) ────────────
  //   Matches: "18 000,00" / "1 800,00" / "100,00" / "10,00" / "190,00"
  //   Does NOT match: "50" / "19" / "1" / "0"
  const fmtNums = extractFormattedNums(rest);
  if (fmtNums.length < 2) return null;

  // ── Map formatted numbers → columns ──────────────────────────────────────
  //   Column order (left→right): Qté, P.U, MHT, [MTVA if TVA>0], MTTC
  //   When TVA=0 the MTVA cell is blank → 4 formatted numbers
  //   When TVA>0 MTVA is filled → 5 formatted numbers
  let qty = null, pu = null, mht = 0, mtva = 0, mttc = 0;

  if (fmtNums.length >= 5) {
    // Full row: qty, pu, mht, mtva, mttc
    [qty, pu, mht, mtva, mttc] = fmtNums.slice(-5);
  } else if (fmtNums.length === 4) {
    if (tvaRate > 0) {
      // TVA present but only 4 formatted nums → likely: pu, mht, mtva, mttc
      [pu, mht, mtva, mttc] = fmtNums;
    } else {
      // TVA=0, no MTVA column → qty, pu, mht, mttc
      [qty, pu, mht, mttc] = fmtNums;
      mtva = 0;
    }
  } else if (fmtNums.length === 3) {
    // pu, mht, mttc  OR  mht, mtva, mttc — pick by TVA
    if (tvaRate > 0) {
      [mht, mtva, mttc] = fmtNums;
    } else {
      [pu, mht, mttc] = fmtNums;
      mtva = 0;
    }
  } else if (fmtNums.length === 2) {
    [mht, mttc] = fmtNums;
  }

  if (!mht || mht <= 0) return null;

  // ── Extract designation text ──────────────────────────────────────────────
  const designation = extractDesignationText(rest);
  if (!designation || designation.length < 2) return null;

  return {
    code,
    designation: designation.trim(),
    qty, pu,
    mht:      round2(mht),
    tva_rate: tvaRate,
    mtva:     round2(mtva || 0),
    mttc:     round2(mttc || mht + (mtva || 0)),
  };
}

// ─── EXTRACT ONLY FORMATTED FRENCH NUMBERS ────────────────────────────────
// Only matches numbers that have a comma-decimal part: "18 000,00", "100,00"
// DOES NOT match bare integers: "50", "19", "1", "0"
function extractFormattedNums(str) {
  const re = /\d{1,3}(?:\s\d{3})*,\d{1,2}/g;
  const ms = str.match(re) || [];
  return ms.map(m => parseFloat(m.replace(/\s/g, '').replace(',', '.')));
}

// ─── EXTRACT DESIGNATION TEXT ─────────────────────────────────────────────
function extractDesignationText(rest) {
  let s = rest;
  // Remove formatted numbers
  s = s.replace(/\d{1,3}(?:\s\d{3})*,\d{1,2}/g, ' ');
  // Remove TVA rate patterns like "0%" "19%"
  s = s.replace(/\b\d{1,2}\s*%/g, ' ');
  // Remove common unit abbreviations (standalone)
  s = s.replace(/\b(UN|KG|L|T|M2?|PCE|PCS|QX|BOX|SAC|SCS|U\.?)\b/gi, ' ');
  // Collapse whitespace, strip leading/trailing digits
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^\d+\s*/, '').trim();
  return s || null;
}

// ─── FALLBACK: SCAN ALL LINES ──────────────────────────────────────────────
function fallbackLineItems(lines) {
  const items = [];
  for (const line of lines) {
    if (!/^\s*\d{1,3}\s/.test(line)) continue;
    if (/^(Total|Arrêt|Montant|Mode|Facture|Client|Date)/i.test(line.trim())) continue;
    const item = tryParseRow(line);
    if (item && item.mht > 0) items.push(item);
  }
  return items;
}

// ─── PARSE TOTALS ──────────────────────────────────────────────────────────
// The real invoices extract in one of two shapes:
//
//  SHAPE A ("block" — the common case in this SARL's invoices): the four
//  labels are emitted together as their own lines, in whatever order the
//  PDF's internal drawing order happens to use (often "Montant Timb",
//  "Total MHT :", "Total MTVA :", "Total MTTC :"), and are immediately
//  followed by a block of four bare numbers. Those four numbers are ALWAYS
//  in the fixed visual/canonical order MHT, MTVA, Timbre, MTTC — regardless
//  of the order the labels themselves appeared in the text stream. Mapping
//  values by label-encounter-order (instead of canonical order) is exactly
//  what caused MTVA/MTTC to get corrupted with the wrong figures.
//
//  SHAPE B (older/other invoice layouts): each label carries its own value
//  on the same line, or on the line immediately following it — e.g.
//  "Montant Timbre : 192,00" or "Montant Timbre :" / "192,00".
const TOTAL_ORDER = ['mht', 'mtva', 'timbre', 'mttc'];

const TOTAL_LABEL_RE = {
  mht:    /Total\s*MHT\b/i,
  mtva:   /Total\s*MTVA\b/i,
  // "Timb" alone, "Timbre", "Montant Timb", "Montant du Timbre", with or without ':'
  timbre: /Montant\s*(du\s*)?Timb(re)?s?\b|(?:^|[^A-Za-zÀ-ÿ])Timbre\b|(?:^|[^A-Za-zÀ-ÿ])Timb\b/i,
  mttc:   /Total\s*MTTC\b/i,
};

// A line that is a "bare" number — nothing else on it besides the figure
// itself (allows an optional trailing currency marker like "DA").
const BARE_NUM_RE = /^\s*\d{1,3}(?:[\s.]\d{3})*,\d{1,2}\s*(?:DA)?\s*$|^\s*\d{2,7}\s*(?:DA)?\s*$/i;

function labelForLine(line) {
  for (const t of TOTAL_ORDER) {
    if (t === 'mht'  && !TOTAL_LABEL_RE.mht.test(line))  continue;
    if (t === 'mht'  && /MTVA/i.test(line)) continue;
    if (TOTAL_LABEL_RE[t].test(line)) return t;
  }
  return null;
}

function parseTotals(lines, inv) {
  const values = { mht: null, mtva: null, timbre: null, mttc: null };

  // ── SHAPE A: contiguous label run → contiguous value run ─────────────────
  for (let i = 0; i < lines.length; i++) {
    const firstLabel = labelForLine(lines[i]);
    if (!firstLabel || extractAnyNums(lines[i]).length > 0) continue; // must be a bare label line

    // Collect the contiguous run of bare label lines starting here
    const runTargets = [firstLabel];
    let j = i + 1;
    while (j < lines.length) {
      const t = labelForLine(lines[j]);
      if (!t || runTargets.includes(t) || extractAnyNums(lines[j]).length > 0) break;
      runTargets.push(t);
      j++;
    }
    if (runTargets.length < 2) continue; // need at least 2 labels to trust this is the block

    // Collect the contiguous run of bare-number lines right after the labels
    const nums = [];
    let k = j;
    while (k < lines.length && nums.length < runTargets.length) {
      if (!BARE_NUM_RE.test(lines[k])) break;
      nums.push(extractAnyNums(lines[k])[0]);
      k++;
    }
    if (nums.length !== runTargets.length) continue; // shape didn't fully match, try elsewhere

    // Map values by FIXED canonical order, restricted to the labels present
    const present = TOTAL_ORDER.filter(t => runTargets.includes(t));
    present.forEach((t, idx) => { values[t] = nums[idx]; });
    break; // found the block — done
  }

  // ── SHAPE B: fallback — each label resolves its own value independently ──
  //
  // Key insight from real PDFs: a line like
  //   "Arrêtée ... Total Qté : 50,00 Total MHT :"
  // has the MHT label at the END with no value after it. The number 50,00
  // belongs to Qté, not MHT. The actual MHT value sits on the PREVIOUS line
  // as a bare number (e.g. "100 000,00"). We must:
  //   (a) extract numbers only AFTER the label position, not before it
  //   (b) look backwards (1 line) when forward look-ahead fails
  if (values.mht === null && values.mtva === null && values.mttc === null) {
    for (const t of TOTAL_ORDER) {
      let foundLineIdx = -1;
      let ourMatch = null;
      for (let i = 0; i < lines.length; i++) {
        if (t === 'mht' && /MTVA/i.test(lines[i])) continue;
        const m = TOTAL_LABEL_RE[t].exec(lines[i]);
        if (m) {
          foundLineIdx = i;
          ourMatch = m;
          break;
        }
      }

      if (foundLineIdx === -1) continue;

      let lineText = lines[foundLineIdx];

      // Extract text AFTER our label (and before the next label, if any)
      const afterLabelStart = ourMatch.index + ourMatch[0].length;
      let afterLabelEnd = lineText.length;
      for (const other of TOTAL_ORDER) {
        if (other === t) continue;
        if (other === 'mht' && /MTVA/i.test(lineText)) continue;
        const otherMatch = TOTAL_LABEL_RE[other].exec(lineText);
        if (otherMatch && otherMatch.index > ourMatch.index) {
          afterLabelEnd = Math.min(afterLabelEnd, otherMatch.index);
        }
      }

      const afterLabelText = lineText.substring(afterLabelStart, afterLabelEnd);
      const ownNums = extractAnyNums(afterLabelText);
      if (ownNums.length > 0) {
        values[t] = ownNums[ownNums.length - 1];
        continue;
      }

      // Look ahead up to 2 lines for the value, stop if we hit another label
      let foundAhead = false;
      for (let j = 1; j <= 2 && foundLineIdx + j < lines.length; j++) {
        const nextLine = lines[foundLineIdx + j];
        let hasLabel = false;
        for (const anyT of TOTAL_ORDER) {
           if (anyT === 'mht' && /MTVA/i.test(nextLine)) continue;
           if (TOTAL_LABEL_RE[anyT].test(nextLine)) { hasLabel = true; break; }
        }
        if (hasLabel) break;

        if (BARE_NUM_RE.test(nextLine)) {
          const nums = extractAnyNums(nextLine);
          if (nums.length > 0) { values[t] = nums[nums.length - 1]; foundAhead = true; break; }
        }
      }

      // Look backwards 1 line — the value may sit on the line ABOVE the label
      // (common when "Total MHT :" ends a line and its value is on the prior line).
      // Only use backward look if: (a) forward didn't find anything, (b) the
      // previous line is a bare number line with no label of its own.
      if (!foundAhead && values[t] === null && foundLineIdx > 0) {
        const prevLine = lines[foundLineIdx - 1];
        let prevHasLabel = false;
        for (const anyT of TOTAL_ORDER) {
          if (anyT === 'mht' && /MTVA/i.test(prevLine)) continue;
          if (TOTAL_LABEL_RE[anyT].test(prevLine)) { prevHasLabel = true; break; }
        }
        if (!prevHasLabel && BARE_NUM_RE.test(prevLine)) {
          const nums = extractAnyNums(prevLine);
          if (nums.length > 0) values[t] = nums[nums.length - 1];
        }
      }
    }
  }

  if (values.mht    !== null) inv.total_mht      = values.mht;
  if (values.mtva   !== null) inv.total_mtva     = values.mtva;
  if (values.timbre !== null) inv.montant_timbre = values.timbre;
  if (values.mttc   !== null) inv.total_mttc     = values.mttc;

  // ── Cross-validation: use line-item sums as a sanity check ──────────────
  // If total_mht looks suspiciously small (like a Qty value instead of an
  // amount), and we haven't parsed line items yet, we can't cross-check here.
  // But we CAN check: if MHT + MTVA + Timbre should equal MTTC but MHT is
  // absurdly small relative to MTTC, the MHT is probably the Qty that leaked
  // from "Total Qté : XX,00 Total MHT :" on the same line.
  // In that case, back-derive MHT = MTTC - MTVA - Timbre.
  if (inv.total_mttc > 0 && inv.total_mht > 0 && inv.total_mht < inv.total_mttc * 0.01) {
    // MHT is less than 1% of MTTC — almost certainly wrong (it's the Qty).
    // Recalculate: MHT = MTTC - MTVA - Timbre
    inv.total_mht = round2(inv.total_mttc - inv.total_mtva - inv.montant_timbre);
  }

  // Enforce business rule: Timbre only applies to Cash (Espèce) payments.
  if (inv.modePaiement && !/Esp[eè]ce/i.test(inv.modePaiement)) {
    inv.montant_timbre = 0;
  }

  // Safety net — if MHT, MTVA and MTTC are all known but the timbre still
  // reads 0, back-derive it arithmetically (MHT + MTVA + Timbre = MTTC).
  // Only do this when the implied timbre is a plausible stamp-duty amount
  // (typically 1% of MTTC, never more than ~5%), AND payment mode is Cash
  // or unknown.
  if (inv.montant_timbre === 0 && inv.total_mttc > 0 && inv.total_mht > 0) {
    if (!inv.modePaiement || /Esp[eè]ce/i.test(inv.modePaiement)) {
      const implied = round2(inv.total_mttc - inv.total_mht - inv.total_mtva);
      if (implied > 0.004 && implied < inv.total_mttc * 0.05) {
        inv.montant_timbre = implied;
      }
    }
  }

  if (inv.total_mttc === 0 && inv.total_mht > 0)
    inv.total_mttc = round2(inv.total_mht + inv.total_mtva + inv.montant_timbre);
}

// ─── EXTRACT ANY NUMBER (formatted comma-decimal, OR plain integer fallback) ─
// Used for the totals block only. Formatted numbers ("18 000,00", "192,00")
// are preferred; if a line has no comma-decimal number at all (some invoices
// print the timbre as a bare integer, e.g. "192"), fall back to plain digits.
function extractAnyNums(str) {
  const commaRe = /\d{1,3}(?:[\s.]\d{3})*,\d{1,2}/g;
  let ms = str.match(commaRe);
  if (ms && ms.length) {
    return ms.map(m => parseFloat(m.replace(/[\s.]/g, '').replace(',', '.')));
  }
  ms = str.match(/\b\d{2,7}\b/g);
  if (ms && ms.length) return ms.map(m => parseFloat(m));
  return [];
}

// ─── PARSE VAT BREAKDOWN TABLE ────────────────────────────────────────────
function parseVatBreakdown(lines, inv) {
  let headerIdx = -1;
  const vatRates = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/TVA\s+(\d+)%/gi);
    if (m && m.length >= 1) {
      headerIdx = i;
      for (const col of m) {
        const r = col.match(/TVA\s+(\d+)%/i);
        if (r) vatRates.push(parseInt(r[1]));
      }
      break;
    }
  }

  if (headerIdx === -1 || vatRates.length === 0) return;

  let htNums = [], tvaNums = [];
  for (let i = headerIdx + 1; i < Math.min(headerIdx + 5, lines.length); i++) {
    const l    = lines[i];
    const nums = extractFormattedNums(l);
    if (/Montant\s*HT|MHT/i.test(l)  && nums.length >= vatRates.length) htNums  = nums;
    if (/Montant\s*TVA|MTVA/i.test(l) && nums.length >= vatRates.length) tvaNums = nums;
  }

  for (let j = 0; j < vatRates.length; j++) {
    inv.vatBreakdown.push({
      rate:        vatRates[j],
      montant_ht:  htNums[j]  || 0,
      montant_tva: tvaNums[j] || 0,
    });
  }
}

function round2(n) { return Math.round((n || 0) * 100) / 100; }

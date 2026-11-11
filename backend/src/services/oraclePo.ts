/** Oracle EBS PO/vendor lookup and invoice API payload preparation. */

type AnyRecord = Record<string, any>;

const PO_API_URL = process.env.ORACLE_PO_DETAILS_URL ||
  'https://ispdev.petmate.com:8500/apex/rest/get/podetails/';

function cleanString(value: any): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function toNumberOrNull(value: any): number | null {
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value).replace(/[$,\s]/g, '').replace(/[()]/g, (m) => m === '(' ? '-' : '');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function normalizePoResponse(payload: any): AnyRecord | null {
  if (!payload || typeof payload !== 'object' || payload.error) return null;
  // Some REST deployments wrap the result in an items/data/result property.
  const data = payload.data || payload.result || payload.items?.[0] || payload;
  if (!data || typeof data !== 'object' || data.error) return null;
  return data;
}

export async function getOraclePoDetails(params: {
  poNumber?: string | null;
  supplierName?: string | null;
}): Promise<AnyRecord | null> {
  const poNumber = cleanString(params.poNumber);
  const supplierName = cleanString(params.supplierName);
  if (!poNumber && !supplierName) return null;

  const url = new URL(PO_API_URL);
  if (poNumber) url.searchParams.set('po_number', poNumber);
  else url.searchParams.set('supplier_name', supplierName!);

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (process.env.ORACLE_PO_API_BEARER_TOKEN) {
    headers.Authorization = `Bearer ${process.env.ORACLE_PO_API_BEARER_TOKEN}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.ORACLE_PO_API_TIMEOUT_MS || 20000));
  try {
    const response = await fetch(url.toString(), { method: 'GET', headers, signal: controller.signal });
    const bodyText = await response.text();
    let body: any;
    try { body = bodyText ? JSON.parse(bodyText) : null; }
    catch { throw new Error(`Oracle PO API returned non-JSON (${response.status}): ${bodyText.slice(0, 300)}`); }
    if (!response.ok) {
      throw new Error(`Oracle PO API HTTP ${response.status}: ${body?.error || bodyText.slice(0, 300)}`);
    }
    return normalizePoResponse(body);
  } catch (error: any) {
    if (error?.name === 'AbortError') throw new Error('Oracle PO API request timed out.');
    throw new Error(`Oracle PO API request failed: ${error?.message || String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

function getLegacyLines(extracted: AnyRecord): AnyRecord[] {
  if (Array.isArray(extracted.line_items)) return extracted.line_items;
  const nested = extracted.invoices?.[0]?.header?.lines;
  return Array.isArray(nested) ? nested : [];
}

function getPoNumber(extracted: AnyRecord, lines: AnyRecord[]): string | null {
  // Only use the validated PO number produced by the extraction normalizer.
  const headerPo = cleanString(extracted.po_number || extracted.invoices?.[0]?.header?.po_number);
  if (headerPo && /^\d{3,}$/.test(headerPo)) return headerPo;
  const linePos = [...new Set(lines.map((line) => cleanString(line.po_number)).filter((v): v is string => !!v && /^\d{3,}$/.test(v)))];
  return linePos.length === 1 ? linePos[0] : null;
}

function normalizedText(value: any): string {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function matchPoLine(invoiceLine: AnyRecord, poLines: AnyRecord[]): AnyRecord | null {
  const eligible = poLines.filter((line) => { const amount = toNumberOrNull(line.line_amount); return amount !== null && amount > 0; });
  if (eligible.length === 1) return eligible[0];

  const itemNo = normalizedText(invoiceLine.item_number);
  if (itemNo) {
    const matches = eligible.filter((line) => normalizedText(line.item_number) === itemNo);
    if (matches.length === 1) return matches[0];
  }

  const description = normalizedText(invoiceLine.description || invoiceLine.line_description);
  if (description) {
    const terms = description.split(' ').filter((word) => word.length >= 4);
    const matches = eligible.filter((line) => {
      const poDescription = normalizedText(line.item_description);
      if (!poDescription) return false;
      const overlap = terms.filter((word) => poDescription.includes(word)).length;
      return terms.length > 0 && overlap / terms.length >= 0.6;
    });
    if (matches.length === 1) return matches[0];
  }

  const qty = toNumberOrNull(invoiceLine.quantity);
  const price = toNumberOrNull(invoiceLine.unit_price);
  const amount = toNumberOrNull(invoiceLine.amount);
  if (qty !== null && price !== null && amount !== null) {
    const matches = eligible.filter((line) =>
      toNumberOrNull(line.item_qty) === qty &&
      toNumberOrNull(line.unit_price) === price &&
      toNumberOrNull(line.line_amount) === amount
    );
    if (matches.length === 1) return matches[0];
  }
  return null;
}

function lineType(line: AnyRecord): string {
  const raw = String(line.line_type || '').toUpperCase();
  if (['ITEM', 'FREIGHT', 'MISCELLANEOUS'].includes(raw)) return raw;
  const description = String(line.description || line.line_description || '').toLowerCase();
  if (/freight|shipping|delivery|handling|transport/.test(description)) return 'FREIGHT';
  if (/tax|surcharge/.test(description)) return 'MISCELLANEOUS';
  return 'ITEM';
}

/**
 * Enrich OCR extraction with Oracle's authoritative supplier/PO master data,
 * then construct the invoice API request body. Extraction data is retained for
 * traceability; unresolved PO line matches remain blank rather than guessed.
 */
export async function enrichAndBuildInvoicePayload(extracted: AnyRecord, rawText = ''): Promise<{
  result: AnyRecord;
  apiPayload: AnyRecord;
  poDetails: AnyRecord | null;
  enrichment: AnyRecord;
}> {
  const source = { ...(extracted || {}) };
  const legacyLines = getLegacyLines(source);
  const poNumber = getPoNumber(source, legacyLines);
  const extractedSupplier = cleanString(source.supplier_name || source.supplier);

  let poDetails: AnyRecord | null = null;
  let lookupType: 'po_number' | 'supplier_name' | 'none' = 'none';
  let lookupError: string | null = null;
  try {
    if (poNumber) {
      lookupType = 'po_number';
      poDetails = await getOraclePoDetails({ poNumber });
      // If the PO lookup has no record, try the supplier master lookup as a safe fallback.
      if (!poDetails && extractedSupplier) {
        lookupType = 'supplier_name';
        poDetails = await getOraclePoDetails({ supplierName: extractedSupplier });
      }
    } else if (extractedSupplier) {
      lookupType = 'supplier_name';
      poDetails = await getOraclePoDetails({ supplierName: extractedSupplier });
    }
  } catch (error: any) {
    lookupError = error.message || String(error);
    console.error('[oracle-po] lookup failed:', lookupError);
  }

  const poLines = Array.isArray(poDetails?.lines) ? poDetails!.lines : [];
  const enrichedLines = legacyLines.map((line, index) => {
    const type = lineType(line);
    const matched = type === 'ITEM' && poDetails && poNumber ? matchPoLine(line, poLines) : null;
    return {
      po_number: poNumber,
      po_line_number: matched?.line_num !== null && matched?.line_num !== undefined ? String(matched.line_num) : '',
      invoice_line_number: index + 1,
      line_type: type,
      item_number: cleanString(matched?.item_number) || cleanString(line.item_number),
      line_description: cleanString(line.description || line.line_description) || cleanString(matched?.item_description),
      quantity: toNumberOrNull(line.quantity),
      unit_price: toNumberOrNull(line.unit_price),
      amount: toNumberOrNull(line.amount),
      unit_measure: cleanString(matched?.uom) || '',
      requestor: cleanString(poDetails?.requestor) || '',
      code_combination_id: matched?.code_combination_id !== null && matched?.code_combination_id !== undefined ? String(matched.code_combination_id) : '',
      default_distribution_account: cleanString(matched?.default_distribution_account) || '',
      po_line_quantity: toNumberOrNull(matched?.item_qty),
      po_line_unit_price: toNumberOrNull(matched?.unit_price),
      po_line_billed_quantity: toNumberOrNull(matched?.qty_billed),
      match_approval_level: cleanString(poDetails?.match_approval_level) || '',
      _po_match_status: type !== 'ITEM' ? 'not_applicable' : matched ? 'matched' : (poNumber ? 'unmatched' : 'not_available'),
    };
  });

  const supplierName = cleanString(poDetails?.supplier) || extractedSupplier;
  const header = {
    invoice_num: cleanString(source.invoice_number || source.invoice_num),
    invoice_description: cleanString(source.invoice_description) || enrichedLines
      .filter((line) => (line.amount ?? 0) > 0)
      .map((line) => line.line_description)
      .filter(Boolean).join('; ').slice(0, 239) || null,
    invoice_date: cleanString(source.invoice_date),
    supplier_name: supplierName,
    supplier_number: cleanString(poDetails?.supplier_number) || cleanString(source.supplier_number),
    supplier_id: poDetails?.supplier_id ?? source.supplier_id ?? null,
    supplier_site_id: poDetails?.supplier_site_id ?? source.supplier_site_id ?? null,
    supplier_site: cleanString(poDetails?.supplier_site) || cleanString(source.supplier_site),
    invoice_amount: toNumberOrNull(source.invoice_amount),
    invoice_currency: cleanString(poDetails?.currency) || cleanString(source.currency || source.invoice_currency),
    attachement_url: cleanString(source.attachement_url || source.attachment_url),
    payment_terms: cleanString(poDetails?.terms) || cleanString(source.payment_terms),
    lines: enrichedLines,
  };

  const apiPayload = { invoices: [{ header }] };
  const result = {
    ...source,
    supplier_name: supplierName,
    supplier_number: header.supplier_number,
    supplier_id: header.supplier_id,
    supplier_site_id: header.supplier_site_id,
    supplier_site: header.supplier_site,
    currency: header.invoice_currency,
    payment_terms: header.payment_terms,
    po_number: poNumber,
    line_items: legacyLines,
    api_payload: apiPayload,
    oracle_po_details: poDetails,
    _enrichment: {
      lookup_type: lookupType,
      lookup_status: poDetails ? 'matched' : lookupError ? 'error' : 'not_found',
      lookup_error: lookupError,
      po_number: poNumber,
      po_line_match_count: enrichedLines.filter((line) => line._po_match_status === 'matched').length,
      po_line_unmatched_count: enrichedLines.filter((line) => line._po_match_status === 'unmatched').length,
    },
  };

  return { result, apiPayload, poDetails, enrichment: result._enrichment };
}

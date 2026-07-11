import * as XLSX from 'xlsx';
import type { Invoice, JournalGroup, JournalRow, MappingRule } from '../types';
const round2 = (n: number) => Math.round(n * 100) / 100;
export function generateJournal(invoices: Invoice[], rules: MappingRule[]): JournalGroup[] {
  return invoices.map((inv) => {
    const label = `CONST FACTURE N°${inv.piece}`;
    const rows: JournalRow[] = [{ piece: inv.piece, date: inv.date, compte: '411000', auxiliaire: inv.clientCode || '', reference: '', libelle: label, debit: inv.total_mttc, credit: '', _rowType: 'client' }];
    const sales = new Map<string, { compte: string; total: number; missing: boolean; designation?: string }>();
    inv.lines.forEach((line) => {
      const rule = rules.find((r) => r.keyword && line.designation?.toLowerCase().includes(r.keyword.toLowerCase()));
      const key = rule?.compte || `missing:${line.designation}`;
      const current = sales.get(key) || { compte: rule?.compte || '', total: 0, missing: !rule, designation: line.designation };
      current.total = round2(current.total + (line.mht || 0)); sales.set(key, current);
    });
    if (!inv.lines.length && inv.total_mht > 0) sales.set('missing:total', { compte: '', total: inv.total_mht, missing: true, designation: '(ligne non détectée)' });
    sales.forEach((sale) => rows.push({ piece: inv.piece, date: inv.date, compte: sale.compte, auxiliaire: '', reference: '', libelle: label, debit: '', credit: sale.total, _rowType: 'sales', _missing: sale.missing, _designation: sale.designation }));
    if (inv.total_mtva > 0) rows.push({ piece: inv.piece, date: inv.date, compte: '445700', auxiliaire: '', reference: '', libelle: label, debit: '', credit: inv.total_mtva, _rowType: 'tva' });
    if (inv.montant_timbre > 0) rows.push({ piece: inv.piece, date: inv.date, compte: '445900', auxiliaire: '', reference: '', libelle: label, debit: '', credit: inv.montant_timbre, _rowType: 'timbre' });
    const totalDebit = round2(rows.reduce((s, r) => s + (Number(r.debit) || 0), 0));
    const totalCredit = round2(rows.reduce((s, r) => s + (Number(r.credit) || 0), 0));
    const missingAccounts = rows.filter((r) => r._missing).map((r) => r._designation || '');
    return { piece: inv.piece, date: inv.date, clientCode: inv.clientCode, clientName: inv.clientName, rows, balanced: Math.abs(totalDebit - totalCredit) < .01, totalDebit, totalCredit, hasMissing: missingAccounts.length > 0, missingAccounts, sourceInvoice: inv };
  });
}
export function exportJournal(groups: JournalGroup[], filename: string) {
  const data: (string | number)[][] = [['PIECE','DATE','COMPTE','CODE_AUX','REFERENCE','LIBELLE','DEBIT','CREDIT']];
  groups.forEach((g, i) => { g.rows.forEach((r) => data.push([r.piece,r.date,r.compte,r.auxiliaire,r.reference,r.libelle,r.debit,r.credit])); if (i < groups.length - 1) data.push(['','','','','','','','']); });
  const wb = XLSX.utils.book_new(); const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [10,12,10,12,12,30,14,14].map((wch) => ({ wch })); XLSX.utils.book_append_sheet(wb, ws, 'Journal'); XLSX.writeFile(wb, filename);
}
export function rebalance(group: JournalGroup): JournalGroup {
  const totalDebit = round2(group.rows.reduce((s,r) => s + (Number(r.debit)||0),0)); const totalCredit = round2(group.rows.reduce((s,r) => s + (Number(r.credit)||0),0));
  return { ...group, totalDebit, totalCredit, balanced: Math.abs(totalDebit-totalCredit)<.01, hasMissing: group.rows.some(r=>r._missing) };
}

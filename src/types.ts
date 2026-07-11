export type Page = 'import' | 'review' | 'mapping' | 'settings';
export interface Account { code: string; libelle: string }
export interface MappingRule { keyword: string; compte: string; libelle: string }
export interface InvoiceLine { designation: string; mht: number; [key: string]: unknown }
export interface Invoice { piece: string; date: string; clientCode?: string; clientName?: string; lines: InvoiceLine[]; total_mht: number; total_mtva: number; montant_timbre: number; total_mttc: number }
export interface JournalRow { piece: string; date: string; compte: string; auxiliaire: string; reference: string; libelle: string; debit: number | ''; credit: number | ''; _rowType: string; _missing?: boolean; _designation?: string }
export interface JournalGroup { piece: string; date: string; clientCode?: string; clientName?: string; rows: JournalRow[]; balanced: boolean; totalDebit: number; totalCredit: number; hasMissing: boolean; missingAccounts: string[]; sourceInvoice: Invoice }

import type { Account, MappingRule } from '../types';
export const DEFAULT_MAPPING_RULES: MappingRule[] = [
  { keyword: 'SON', compte: '701002', libelle: 'Son' }, { keyword: 'FARINE', compte: '701001', libelle: 'Farine' },
  { keyword: 'PRESTATION', compte: '706000', libelle: 'Prestation' }, { keyword: 'CONDITIONNEMENT', compte: '706000', libelle: 'Prestation' },
];
export const DEFAULT_ACCOUNTS: Account[] = [
  { code: '411000', libelle: 'Clients' }, { code: '445700', libelle: 'TVA collectée' },
  { code: '445900', libelle: 'Autres impôts et taxes — Timbre' }, { code: '701001', libelle: 'Farine' },
  { code: '701002', libelle: 'Son' }, { code: '706000', libelle: 'Prestations de services' },
];

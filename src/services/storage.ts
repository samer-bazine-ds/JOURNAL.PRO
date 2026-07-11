import type { Account, MappingRule } from '../types';
export function loadList<T>(key: string, fallback: T[]): T[] { try { const value = localStorage.getItem(key); return value ? JSON.parse(value) : structuredClone(fallback); } catch { return structuredClone(fallback); } }
export function saveSettings(rules: MappingRule[], accounts: Account[]) { localStorage.setItem('mappingRules', JSON.stringify(rules)); localStorage.setItem('chartOfAccounts', JSON.stringify(accounts)); }

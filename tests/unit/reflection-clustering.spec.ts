import { describe, it, expect } from 'vitest';
import { clusterCorrections, normalizeDescricao } from '../../src/agent/reflection-clustering.js';

describe('reflection-clustering — normalizeDescricao', () => {
  it('strips accents and lowercases', () => {
    expect(normalizeDescricao('Almoço Café')).toBe('almoco cafe');
  });

  it('drops stopwords and digits', () => {
    expect(normalizeDescricao('pagamento de aluguel 2026')).toBe('pagamento aluguel');
  });

  it('truncates to first 4 significant tokens', () => {
    expect(normalizeDescricao('uber transporte trabalho centro casa volta')).toBe(
      'uber transporte trabalho centro',
    );
  });

  it('returns empty string for empty input', () => {
    expect(normalizeDescricao('')).toBe('');
  });

  it('returns empty string when input is only stopwords and digits', () => {
    expect(normalizeDescricao('de da 2026 1234')).toBe('');
  });
});

describe('reflection-clustering — clusterCorrections', () => {
  it('groups corrections with the same normalized descricao', () => {
    const clusters = clusterCorrections([
      { alvo_id: 'a', descricao: 'Uber Trip', contexto: {} },
      { alvo_id: 'b', descricao: 'uber trip', contexto: {} },
      { alvo_id: 'c', descricao: 'Almoço', contexto: {} },
    ]);
    expect(clusters).toHaveLength(2);
    const uber = clusters.find((c) => c.key === 'uber trip');
    expect(uber?.signals).toHaveLength(2);
  });

  it('orders clusters by signal count descending', () => {
    const clusters = clusterCorrections([
      { alvo_id: '1', descricao: 'mercado dia', contexto: {} },
      { alvo_id: '2', descricao: 'mercado dia', contexto: {} },
      { alvo_id: '3', descricao: 'mercado dia', contexto: {} },
      { alvo_id: '4', descricao: 'pix joao', contexto: {} },
    ]);
    expect(clusters[0]?.signals).toHaveLength(3);
    expect(clusters[1]?.signals).toHaveLength(1);
  });

  it('drops empty descricoes', () => {
    const clusters = clusterCorrections([
      { alvo_id: '1', descricao: '12 34', contexto: {} },
      { alvo_id: '2', descricao: 'real one', contexto: {} },
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.key).toBe('real one');
  });
});

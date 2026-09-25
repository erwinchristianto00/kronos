const reasons: Record<string, string> = {
  PREFERRED_RECENT_STRENGTH_ALIGNED: 'Alternatif lolos syarat dan dipilih oleh preference saat pembentukan basket.',
  BASELINE_ALREADY_BEST: 'Kombinasi baseline tetap menjadi pilihan terbaik.',
  RECENT_STRENGTH_MIXED: 'Tidak ada alternatif yang memenuhi syarat kekuatan 1h dan 4h; baseline dipertahankan.',
  RECENT_STRENGTH_UNAVAILABLE: 'Data kekuatan terbaru tidak tersedia; baseline dipertahankan.',
  SEARCH_EXHAUSTED: 'Pencarian mencapai batas yang diizinkan; baseline dipertahankan.',
};

export default function BasketSelectionBadge({ preference }: { preference?: unknown }) {
  const row = preference && typeof preference === 'object' ? preference as Record<string, unknown> : null;
  const mode = row?.policyId === 'cross-preference-formation-v1' ? row.selectionMode : null;
  const recorded = mode === 'BASELINE' || mode === 'PREFERRED';
  const label = mode === 'PREFERRED' ? 'Qualified alternative' : mode === 'BASELINE' ? 'Baseline' : 'Pilihan tidak terekam';
  const description = recorded
    ? reasons[String(row?.reason)] ?? 'Hasil pemilihan yang dibekukan saat basket dibentuk.'
    : 'Basket ini tidak menyimpan bukti preference saat dibentuk; baseline atau alternatif tidak bisa dipastikan.';
  return <span title={description} style={{ display: 'inline-block', fontSize: 12, border: '1px solid currentColor', borderRadius: 4, padding: '2px 6px', color: recorded ? '#83c9bf' : '#99a7b5' }}>
    {label}
  </span>;
}

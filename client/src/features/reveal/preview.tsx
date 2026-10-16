// Черновой предпросмотр флипа (docs/16 §2.1) — как shots.html для арта.
// Файл живёт только пока идёт приёмка движения и не входит в сборку: в
// rollupOptions.input он не добавлен, `bundle:check` его не видит.
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { PackRevealAnimation } from './PackRevealAnimation';
import { ChipArt } from '@/shared/ui/ChipArt';
import { chipArtUrl, chipName, rarityColor, rarityName } from '@/shared/lib/rarity';
import '@/shared/ui/theme.css';

const RARITIES = [0, 1, 2, 3, 4, 5, 6, 7, 8];

function Preview() {
  const [rarity, setRarity] = useState(5);
  const [fused, setFused] = useState(false);
  const [running, setRunning] = useState(false);
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', gap: 16, background: '#0b0b0e', color: '#e8e8ea', fontFamily: 'system-ui' }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 520 }}>
        {RARITIES.map((r) => (
          <button key={r} onClick={() => { setRarity(r); setRunning(true); }}
            style={{ padding: '6px 10px', borderRadius: 8, border: `1px solid ${r === rarity ? '#FF2E8A' : '#333'}`, background: '#16151a', color: '#e8e8ea', cursor: 'pointer' }}>
            {rarityName(r)}
          </button>
        ))}
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={fused} onChange={(e) => setFused(e.target.checked)} /> fusion (двойной флип у Legend+)
      </label>
      {!running && <button onClick={() => setRunning(true)} style={{ padding: '10px 18px', borderRadius: 10, background: '#FF2E8A', color: '#0b0b0e', border: 0, cursor: 'pointer' }}>Показать вскрытие</button>}
      {running && (
        <PackRevealAnimation
          rarity={rarity}
          chipName={chipName(0, rarity)}
          chipArt={<ChipArt collection={0} rarity={rarity} index={0} level={1} imageUrl={chipArtUrl(0, rarity, 512)} crimp={rarityColor(rarity)} />}
          isOnChain
          fused={fused}
          onDone={() => setRunning(false)}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Preview />);

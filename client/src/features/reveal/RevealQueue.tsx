import { useT } from '@/shared/i18n';
// Global reveal overlay: plays the existing PackRevealAnimation for every
// item in ui.revealQueue, one at a time. Fed by the pack flow, fusion flow
// and quest chip rewards. Reduced-motion collapses to the final card.
import { useCallback } from 'react';
import { useUiStore } from '@/app/store/ui';
import { PackRevealAnimation } from './PackRevealAnimation';
import { chipName, rarityName, chipArtUrl } from '@/shared/lib/rarity';
import { ChipArt } from '@/shared/ui/ChipArt';
import { rarityColor } from '@/shared/lib/rarity';

export function RevealQueue() {
  const t = useT();
  const queue = useUiStore((s) => s.revealQueue);
  const shift = useUiStore((s) => s.shiftReveal);
  const reduced = useUiStore((s) => s.reducedMotion);
  const instant = useUiStore((s) => s.instantReveal);
  const head = queue[0];
  const done = useCallback(() => shift(), [shift]);
  if (!head) return null;

  if (reduced || instant) {
    return (
      <div className="modal-backdrop" onClick={done} style={{ zIndex: 90 }}>
        <div className="modal center stack" onClick={(e) => e.stopPropagation()}>
          <div style={{ width: 270, margin: '0 auto' }}><ChipArt collection={head.collectionIdx} rarity={head.rarity} index={head.index} level={head.level} imageUrl={chipArtUrl(head.collectionIdx, head.rarity, 512)} crimp={rarityColor(head.rarity)} founder={head.founder} /></div>
          <div className="cg-heading" style={{ fontSize: 22 }}>{chipName(head.collectionIdx, head.rarity)}</div>
          <div className="muted">{rarityName(head.rarity)}{head.founder ? ` · ${t('collection.founderBadge')}` : ''}{head.fused ? ` · ${t('fusion.success')}` : ''} · {queue.length - 1} {t('ui.more')}</div>
          <button className="btn btn-block" onClick={done}>{t('ui.next')}</button>
        </div>
      </div>
    );
  }

  return (
    <PackRevealAnimation
      key={head.id}
      rarity={head.rarity}
      chipName={chipName(head.collectionIdx, head.rarity)}
      chipArt={<ChipArt collection={head.collectionIdx} rarity={head.rarity} index={head.index} level={head.level} imageUrl={chipArtUrl(head.collectionIdx, head.rarity, 512)} crimp={rarityColor(head.rarity)} founder={head.founder} />}
      isOnChain
      remaining={queue.length - 1}
      sku={head.sku}
      founder={head.founder}
      onDone={done}
    />
  );
}

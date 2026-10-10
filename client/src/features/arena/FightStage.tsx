// Shared 3v3 clash strip: ranked replay plays real rounds; wager plays a looping
// slam while the chain settles. Never invents a winner — that comes from the match
// or the battle account.
import { useEffect, useState } from 'react';
import { ChipArt } from '@/shared/ui/ChipArt';
import { chipImageOf } from '@/shared/lib/rarity';

export type FightCap = {
  asset?: string;
  collection?: number | null;
  rarity?: number | null;
  level?: number | null;
  index?: number | null;
  imageUrl?: string | null;
  skin?: string | null;
};

function trio(xs: Array<FightCap | null | undefined> | undefined): Array<FightCap | null> {
  const out: Array<FightCap | null> = [null, null, null];
  (xs ?? []).slice(0, 3).forEach((c, i) => {
    if (c && c.collection != null && c.rarity != null) out[i] = c;
  });
  return out;
}

function Cap({ c, side, clash }: { c: FightCap | null; side: 'a' | 'b'; clash: boolean }) {
  return (
    <div className={`fight-cap fight-cap-${side}${clash ? ' is-clash' : ''}${c ? '' : ' live-slot'}`}>
      {c ? (
        <ChipArt
          collection={c.collection!}
          rarity={c.rarity!}
          index={c.index}
          level={c.level ?? undefined}
          imageUrl={c.imageUrl ?? chipImageOf(c)}
          skin={c.skin}
          size="100%"
        />
      ) : null}
    </div>
  );
}

export function FightStage({
  left,
  right,
  liveIndex,
  looping,
}: {
  left?: Array<FightCap | null | undefined>;
  right?: Array<FightCap | null | undefined>;
  /** which pair is slamming; ignored when looping */
  liveIndex?: number;
  looping?: boolean;
}) {
  const a = trio(left);
  const b = trio(right);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!looping) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 900);
    return () => window.clearInterval(id);
  }, [looping]);
  const clash = looping ? tick % 3 : liveIndex ?? -1;
  return (
    <div className="fight-stage" aria-hidden="true">
      <div className="fight-trio">
        {a.map((c, i) => <Cap key={`a${i}`} c={c} side="a" clash={clash === i} />)}
      </div>
      <div className="fight-vs">VS</div>
      <div className="fight-trio">
        {b.map((c, i) => <Cap key={`b${i}`} c={c} side="b" clash={clash === i} />)}
      </div>
    </div>
  );
}

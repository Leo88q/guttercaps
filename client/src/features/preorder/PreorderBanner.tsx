// Always-on entry to /preorder. Campaign activity only changes the status line and
// whether the pre-sale page offers a reservation — it must not hide the screen.
import { Link } from 'react-router-dom';
import { usePreorderCampaign } from '@/api/hooks';
import { useT } from '@/shared/i18n';
import { ChevronRightIcon } from '@/shared/ui/action-icons';
import { Pill } from '@/shared/ui/primitives';

export function preorderStatusLine(
  t: ReturnType<typeof useT>,
  c?: { active?: boolean; remaining?: number; total?: number } | null,
): string {
  if (!c) return t('preorder.tagline');
  if (c.active && (c.remaining ?? 0) > 0) return t('preorder.left', { n: c.remaining ?? 0, total: c.total ?? 0 });
  if (c.active) return t('preorder.soldOut');
  return t('preorder.ended');
}

export function PreorderBanner({ testId, variant = 'home' }: { testId: string; variant?: 'home' | 'shop' }) {
  const t = useT();
  const campaign = usePreorderCampaign();
  const c = campaign.data;
  const live = !!(c?.active && (c.remaining ?? 0) > 0);
  const status = preorderStatusLine(t, c);
  return (
    <Link
      to="/preorder"
      data-testid={testId}
      className="card preorder-banner"
      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, textDecoration: 'none', marginBottom: variant === 'shop' ? 16 : undefined, borderColor: 'rgba(255,122,26,0.4)' }}
    >
      {variant === 'shop' && live ? (
        <>
          <div style={{ fontSize: 13, color: '#ddd' }}>{t('preorder.shopBanner')}</div>
          <Pill tone="ok">{t('preorder.shopCta')} →</Pill>
        </>
      ) : (
        <>
          <div>
            <strong style={{ fontSize: 14 }}>{t('preorder.title')}</strong>
            <div className="tiny" style={{ marginTop: 2 }}>{status}</div>
          </div>
          <ChevronRightIcon size={20} />
        </>
      )}
    </Link>
  );
}
